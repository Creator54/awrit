import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { encodeToolResult } from '../browserOwner/tools/encode';
import { getSocketPath, isSocketAlive } from '../ipc/socketServer';
import { findRemotePane, readRemotePanes, type RemotePaneEntry } from '../remote/registry';
import { UsageError } from './usageError';

export interface ToolTarget {
  paneId?: string;
  sourceWindowId?: string;
}

export interface ParsedToolArgs {
  name: string;
  input: Record<string, unknown>;
  target: ToolTarget;
}

const USAGE = 'Usage: awrit tool <name|list> [JSON input] [--pane ID]';
const REQUEST_TIMEOUT_MS = 35_000; // owner caps a tool at 30s
export const REMOTE_TIMEOUT_MS = 60_000; // ssh round trip plus the owner's own cap
const REMOTE_STATUS_TIMEOUT_MS = 2_000;

export function parseToolArgs(args: string[]): ParsedToolArgs {
  const positional: string[] = [];
  const target: ToolTarget = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pane') {
      if (target.paneId !== undefined) throw new UsageError(`Specify --pane only once. ${USAGE}`);
      const id = args[++i];
      if (!id || id.startsWith('-')) throw new UsageError(`Missing value for --pane. ${USAGE}`);
      target.paneId = id;
    } else if (args[i].startsWith('-')) {
      throw new UsageError(`Unknown option: ${args[i]}. ${USAGE}`);
    } else {
      positional.push(args[i]);
    }
  }
  const [name, rawInput, extra] = positional;
  if (!name) throw new UsageError(USAGE);
  if (extra !== undefined) throw new UsageError(`Unexpected argument: ${extra}. ${USAGE}`);

  let input: unknown = {};
  if (rawInput !== undefined) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      throw new UsageError(`Input must be a JSON object. ${USAGE}`);
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UsageError(`Input must be a JSON object. ${USAGE}`);
  }
  return { name, input: input as Record<string, unknown>, target };
}

/** Sends one request to the running viewer and resolves with its `data` payload. */
export async function request(
  socketPath: string,
  type:
    | 'tool:call'
    | 'tools:list'
    | 'viewer:status'
    | 'capture:request'
    | 'overlay:text',
  payload: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (!(await isSocketAlive(socketPath, 200))) {
    throw new Error('No running Awrit viewer. Open a page first, for example: awrit show <url>');
  }
  const requestId = randomBytes(4).toString('hex');
  const client = net.connect(socketPath);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Tool request timed out')), timeoutMs);
    let buf = '';
    const done = () => {
      clearTimeout(timer);
      client.destroy();
    };
    const fail = (err: Error) => {
      done();
      reject(err);
    };
    client.on('connect', () =>
      client.write(JSON.stringify({ type, requestId, ...payload }) + '\n'),
    );
    client.on('error', fail);
    client.on('close', () => fail(new Error('Connection closed by the viewer')));
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: {
          type?: string;
          requestId?: string;
          ok?: boolean;
          data?: unknown;
          error?: string;
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type !== `${type}:response` || msg.requestId !== requestId) continue;
        if (msg.ok) {
          done();
          resolve(msg.data);
        } else {
          fail(new Error(msg.error ?? 'Tool request failed'));
        }
        return;
      }
    });
  });
}

/** Names the harness that runs this command, so the viewer can label the agent cursor. */
export function detectAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLAUDECODE || env.CLAUDE_CODE) return 'Claude';
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return 'Codex';
  if (env.OPENCODE) return 'OpenCode';
  if (env.PI_CODING_AGENT) return 'Pi';
  return undefined;
}

export function callOwnerTool(
  socketPath: string,
  name: string,
  input: Record<string, unknown>,
  target: ToolTarget,
): Promise<unknown> {
  return request(socketPath, 'tool:call', { ...target, name, arguments: input, agent: detectAgentName() });
}

export function listOwnerTools(socketPath: string, target: ToolTarget = {}): Promise<unknown> {
  return request(socketPath, 'tools:list', { ...target });
}

/** The local owner either is not running or has no viewer for this window. */
export function isLocalMiss(message: string): boolean {
  return (
    message.includes('No running Awrit viewer') ||
    message.includes('No matching active viewer pane')
  );
}

/** A remote viewer publishes a local socket that speaks the same request framing. */
function callRemoteTool(
  entry: RemotePaneEntry,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return request(entry.socket, 'tool:call', { name, arguments: input, agent: detectAgentName() }, REMOTE_TIMEOUT_MS);
}

/** CLI entry: prints a compact result and returns the process exit code. */
export async function runToolCommand(args: string[]): Promise<number> {
  let parsed: ParsedToolArgs;
  try {
    parsed = parseToolArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const { name, input, target } = parsed;
  try {
    const socketPath = getSocketPath();
    const fromKitty = process.env.KITTY_WINDOW_ID;
    const scoped: ToolTarget = { ...(fromKitty ? { sourceWindowId: fromKitty } : {}), ...target };
    const remotePane = () =>
      findRemotePane({
        ...(fromKitty ? { windowId: fromKitty } : {}),
        ...(target.paneId ? { paneId: target.paneId } : {}),
      });
    if (name === 'list') {
      let tools: unknown;
      try {
        tools = await listOwnerTools(socketPath, scoped);
      } catch (err) {
        const remote = isLocalMiss(err instanceof Error ? err.message : String(err))
          ? remotePane()
          : undefined;
        if (!remote) throw err;
        tools = await request(remote.socket, 'tools:list', {}, REMOTE_TIMEOUT_MS);
      }
      // Plain JSON: compact table syntax made nested input schemas hard to read.
      console.log(JSON.stringify(tools, null, 2));
      return 0;
    }
    let result: unknown;
    try {
      result = await callOwnerTool(socketPath, name, input, scoped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const remote = isLocalMiss(message) ? remotePane() : undefined;
      if (remote) {
        result = await callRemoteTool(remote, name, input);
      } else {
        // Never fall back to another window's viewer: it belongs to a different task.
        if (message.includes('No matching active viewer pane') && !target.paneId)
          throw new Error(
            'No viewer is open in this terminal window. Open one with: awrit show URL --mode split --json',
          );
        throw err;
      }
    }
    console.log(encodeToolResult(result));
    const failed =
      typeof result === 'object' && result !== null && Reflect.get(result, 'ok') === false;
    return failed ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

interface WindowViewer {
  paneId: string;
  url: string;
  loading: boolean;
  designMode: boolean;
}

export interface ViewerStatus {
  viewer: boolean;
  viewers: WindowViewer[];
  next: string;
}

/** Turns the owner's reply into what the agent should do next. Only this window's viewers count. */
export function describeStatus(viewers: WindowViewer[]): ViewerStatus {
  if (!viewers.length)
    return {
      viewer: false,
      viewers,
      next: 'No viewer is open in this terminal window.',
    };
  if (viewers.length > 1)
    return {
      viewer: true,
      viewers,
      next: 'Several viewers in this window. Add --pane ID to awrit tool commands.',
    };
  const [only] = viewers;
  if (only.designMode)
    return {
      viewer: true,
      viewers,
      next: 'The user is reviewing this page. Wait for their feedback.',
    };
  if (only.loading)
    return {
      viewer: true,
      viewers,
      next: 'Page is loading. Run: awrit tool wait, then awrit tool text',
    };
  return {
    viewer: true,
    viewers,
    next: 'Use this viewer: awrit tool text to read it, awrit tool navigate \'{"url":"URL"}\' to open a page.',
  };
}

function decodeViewers(data: unknown): WindowViewer[] {
  const list = typeof data === 'object' && data !== null ? Reflect.get(data, 'viewers') : undefined;
  if (!Array.isArray(list)) throw new Error('Invalid viewer status reply');
  return list.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid viewer status reply');
    const field = (key: string) => Reflect.get(item, key);
    const [paneId, url] = [field('paneId'), field('url')];
    if (typeof paneId !== 'string' || typeof url !== 'string')
      throw new Error('Invalid viewer status reply');
    return {
      paneId,
      url,
      loading: field('loading') === true,
      designMode: field('designMode') === true,
    };
  });
}

/** One remote viewer's state; a reconnecting tunnel still counts as this window's viewer. */
async function remoteViewer(entry: RemotePaneEntry): Promise<WindowViewer> {
  try {
    const [viewer] = decodeViewers(
      await request(entry.socket, 'viewer:status', {}, REMOTE_STATUS_TIMEOUT_MS),
    );
    if (viewer) return viewer;
  } catch {
    // Fall through: report the pane so the agent does not open a second viewer.
  }
  return { paneId: entry.session, url: '', loading: false, designMode: false };
}

/** Viewer state for this terminal window. Never reports another window's viewers. */
export async function readStatus(windowId = process.env.KITTY_WINDOW_ID): Promise<ViewerStatus> {
  if (!windowId) return describeStatus([]);
  const socketPath = getSocketPath();
  if (await isSocketAlive(socketPath, 200)) {
    const local = decodeViewers(
      await request(socketPath, 'viewer:status', { sourceWindowId: windowId }, 300),
    );
    // A local viewer wins; remote panes only fill in when this window has none.
    if (local.length) return describeStatus(local);
  }
  const remote = readRemotePanes().filter((pane) => pane.sourceWindowId === windowId);
  return describeStatus(await Promise.all(remote.map(remoteViewer)));
}

/** CLI entry for `awrit status`: always prints JSON so agents can check before browsing. */
export async function runStatusCommand(): Promise<number> {
  try {
    console.log(JSON.stringify(await readStatus()));
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        viewer: false,
        viewers: [],
        next: `Could not read the viewer state: ${reason}`,
      }),
    );
    return 1;
  }
}
