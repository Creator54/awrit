import fs from 'node:fs';
import path from 'node:path';

export const PI_EXTENSION_HEADER = '// @awrit-managed-pi-extension';

export const PI_EXTENSION_SCRIPT = `${PI_EXTENSION_HEADER}
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';

function getSocketPath(): string {
  if (process.env.AWRIT_IPC_SOCKET) return process.env.AWRIT_IPC_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'awrit', 'ipc.sock');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return path.join('/tmp', \`awrit-\${uid}\`, 'ipc.sock');
}

export default function (pi: any) {
  let client: net.Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let buffer = '';
  let destroyed = false;

  const MAX_DRAFT_IDS = 128;
  const feedbackPromises = new Map<string, Promise<boolean>>();
  const settledDraftIds = new Set<string>();
  const traceFile = process.env.AWRIT_TRACE_FEEDBACK;
  const tracedMessages = new Map<string, string>();
  let traceSessionId: string | undefined;
  // Inside TUIOS every pane shares one Kitty window, and TUIOS hides KITTY_WINDOW_ID; its pane id tells panes apart.
  const terminalId = process.env.TUIOS_PANE_ID || process.env.KITTY_WINDOW_ID || null;
  function traceFeedback(event: string, draftId: string, ok?: boolean) {
    if (!traceFile) return;
    try {
      fs.appendFileSync(traceFile, JSON.stringify({ event, draftId, timestamp: new Date().toISOString(), pid: process.pid, windowId: terminalId, sessionId: traceSessionId, ...(ok === undefined ? {} : { ok }) }) + '\\n', { mode: 0o600 });
    } catch { /* Diagnostic output must not affect feedback delivery. */ }
  }
  if (traceFile && typeof pi?.on === 'function') {
    pi.on('session_start', (_event: any, context: any) => {
      traceSessionId = context?.sessionManager?.getSessionId?.();
    });
    pi.on('message_end', (event: any, context: any) => {
      traceSessionId = context?.sessionManager?.getSessionId?.() ?? traceSessionId;
      if (event.message?.role !== 'user') return;
      const content = event.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') : '';
      for (const [draftId, message] of tracedMessages) {
        if (text === message) {
          traceFeedback('user-message-observed', draftId);
          tracedMessages.delete(draftId);
        }
      }
    });
  }

  function connect() {
    if (destroyed || client) return;
    const sockPath = getSocketPath();
    if (!fs.existsSync(sockPath)) {
      scheduleReconnect(2000);
      return;
    }

    try {
      client = net.connect(sockPath);
    } catch {
      scheduleReconnect(2000);
      return;
    }

    client.on('connect', () => {
      buffer = '';
      // Send handshake identifying this agent session with harness, PID, window ID, and cwd
      try {
        const handshake = JSON.stringify({
          type: 'handshake',
          harness: 'pi',
          windowId: terminalId,
          pid: process.pid,
          cwd: process.cwd(),
          feedbackAck: true,
        }) + '\\n';
        client?.write(handshake);
      } catch {}
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          void handleMessage(msg);
        } catch {}
      }
    });

    client.on('error', () => {
      cleanupClient();
      scheduleReconnect(2000);
    });

    client.on('close', () => {
      cleanupClient();
      scheduleReconnect(2000);
    });
  }

  function cleanupClient() {
    if (client) {
      client.removeAllListeners();
      try { client.destroy(); } catch {}
      client = null;
    }
  }

  function scheduleReconnect(delayMs: number) {
    if (destroyed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  }

  async function handleMessage(msg: any) {
    try {
      if (msg?.event !== 'design:send-feedback') {
        return;
      }

      const myWindowId = terminalId;
      const targetSourceId = msg.sourceWindowId ? String(msg.sourceWindowId) : null;

      // Require strict myWindowId and msg.sourceWindowId match (no viewerfallback/adopted exceptions)
      if (!myWindowId || !targetSourceId || myWindowId !== targetSourceId) {
        return;
      }

      if (typeof msg.draftId !== 'string' || !msg.draftId.trim()) return;

      const draftId = msg.draftId.trim();
      traceFeedback('received', draftId);
      const replySocket = client;

      let promise = feedbackPromises.get(draftId);
      if (!promise) {
        if (feedbackPromises.size >= MAX_DRAFT_IDS) {
          let evictKey: string | null = null;
          for (const key of feedbackPromises.keys()) {
            if (settledDraftIds.has(key)) {
              evictKey = key;
              break;
            }
          }
          if (!evictKey) {
            // Negative ack on capacity exhaustion when all entries are in-flight
            if (replySocket && !replySocket.destroyed) {
              try {
                replySocket.write(JSON.stringify({
                  type: 'design:feedback-ack',
                  draftId,
                  ok: false,
                }) + '\\n');
              } catch {}
            }
            return;
          }
          feedbackPromises.delete(evictKey);
          settledDraftIds.delete(evictKey);
          tracedMessages.delete(evictKey);
        }

        const message = msg.summary || 'Design feedback received';
        if (traceFile) tracedMessages.set(draftId, message);
        promise = (async () => {
          try {
            if (typeof pi?.sendUserMessage === 'function') {
              await pi.sendUserMessage(message, { deliverAs: 'followUp' });
              traceFeedback('send-call-resolved', draftId, true);
              return true;
            }
            return false;
          } catch {
            traceFeedback('send-call-rejected', draftId, false);
            tracedMessages.delete(draftId);
            return false;
          }
        })();

        promise.finally(() => {
          settledDraftIds.add(draftId);
        });

        feedbackPromises.set(draftId, promise);
      }

      const ok = await promise;

      if (replySocket && !replySocket.destroyed) {
        try {
          replySocket.write(JSON.stringify({
            type: 'design:feedback-ack',
            draftId,
            ok,
          }) + '\\n');
        } catch {}
      }
    } catch {
      // Catch rejection internally
    }
  }

  // In-process subagents load their own copy of this extension in the same window. Only the
  // interactive (tui) or rpc session may connect; otherwise the viewer can bind to a subagent
  // and its feedback lands in that hidden session.
  if (typeof pi?.on === 'function') {
    pi.on('session_start', (_event: any, context: any) => {
      const mode = context?.mode;
      if (mode === undefined || mode === 'tui' || mode === 'rpc') connect();
    });
  } else {
    connect();
  }

  // Tells the model whether this window has a viewer, so it can choose without running a check.
  // Sent on the first turn and again only when the state changes, to keep the prompt stable.
  // Page text is never included: it is untrusted and the model can read it with awrit tool text.
  let lastStatus = '';
  let statusUnsupported = false;
  let viewerOpen = false;
  let reminded = false;
  const NO_VIEWER = 'Awrit status: no viewer is open in this terminal window.';
  const UNKNOWN = 'Awrit status: unknown, the viewer did not answer. Run awrit status before opening another viewer.';
  function viewerStatus(): Promise<string> {
    const windowId = terminalId;
    if (!windowId || !fs.existsSync(getSocketPath())) return Promise.resolve(NO_VIEWER);
    if (statusUnsupported) return Promise.resolve(UNKNOWN);
    return new Promise((resolve) => {
      const socket = net.connect(getSocketPath());
      let buffer = '';
      const finish = (text: string) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(text);
      };
      // An older viewer never answers; stop asking so later turns are not delayed.
      const timer = setTimeout(() => {
        statusUnsupported = true;
        finish(UNKNOWN);
      }, 500);
      socket.on('error', () => finish(NO_VIEWER));
      socket.on('connect', () =>
        socket.write(JSON.stringify({ type: 'viewer:status', requestId: 'status', sourceWindowId: windowId }) + '\\n'),
      );
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          let reply: { type?: unknown; data?: { viewers?: { loading?: unknown }[] } };
          try {
            reply = JSON.parse(line);
          } catch {
            continue;
          }
          if (reply.type !== 'viewer:status:response') continue;
          const viewers = Array.isArray(reply.data?.viewers) ? reply.data.viewers : [];
          if (!viewers.length) return finish(NO_VIEWER);
          if (viewers.length > 1)
            return finish('Awrit status: ' + viewers.length + ' viewers are open in this terminal window. Pass --pane ID to awrit tool commands.');
          return finish(
            viewers[0].loading === true
              ? 'Awrit status: a viewer is open in this terminal window and its page is loading. Open and read pages there with awrit tool navigate and awrit tool text, not curl.'
              : 'Awrit status: a viewer is open in this terminal window. Open and read pages there with awrit tool navigate and awrit tool text, not curl.',
          );
        }
      });
    });
  }

  if (typeof pi?.on === 'function') {
    pi.on('before_agent_start', async () => {
      const status = await viewerStatus();
      viewerOpen = status !== NO_VIEWER && status !== UNKNOWN;
      if (status === lastStatus) return;
      lastStatus = status;
      return { message: { customType: 'awrit-status', content: status, display: false } };
    });
    // Reminds once per session; never blocks, since curl is right for APIs and downloads.
    pi.on('tool_result', (event: any) => {
      if (reminded || !viewerOpen || event?.toolName !== 'bash') return;
      if (!/\\b(curl|wget)\\b[^|;&]*https?:\\/\\//.test(String(event.input?.command ?? ''))) return;
      reminded = true;
      return {
        content: [
          ...(event.content ?? []),
          { type: 'text', text: 'Awrit: a viewer is open in this window. To read web pages, use awrit tool navigate and awrit tool text so the user can follow along.' },
        ],
        structuredContent: event.structuredContent,
      };
    });
    pi.on('session_shutdown', () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cleanupClient();
    });
  }
}
`;

export function piExtensionPath(home: string, env: NodeJS.ProcessEnv): string {
  const baseDir = env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent');
  return path.join(baseDir, 'extensions', 'awrit.ts');
}

export function isPiExtensionInstalled(home: string, env: NodeJS.ProcessEnv): boolean {
  const filePath = piExtensionPath(home, env);
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.startsWith(PI_EXTENSION_HEADER);
  } catch {
    return false;
  }
}

export interface SetupPiExtensionOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  dryRun?: boolean;
  uninstall?: boolean;
}

export interface SetupPiExtensionReceipt {
  action: 'create' | 'update' | 'remove' | 'unchanged';
  path: string;
}

export function setupPiExtension(options: SetupPiExtensionOptions): SetupPiExtensionReceipt {
  const filePath = piExtensionPath(options.home, options.env);

  if (options.uninstall) {
    if (!fs.existsSync(filePath)) {
      return { action: 'unchanged', path: filePath };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.startsWith(PI_EXTENSION_HEADER)) {
      return { action: 'unchanged', path: filePath };
    }
    if (!options.dryRun) {
      fs.unlinkSync(filePath);
    }
    return { action: 'remove', path: filePath };
  }

  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === PI_EXTENSION_SCRIPT) {
      return { action: 'unchanged', path: filePath };
    }
    if (!current.startsWith(PI_EXTENSION_HEADER)) {
      throw new Error(`Refusing to overwrite unmanaged Pi extension: ${filePath}`);
    }
    if (!options.dryRun) {
      fs.writeFileSync(filePath, PI_EXTENSION_SCRIPT, { mode: 0o600 });
    }
    return { action: 'update', path: filePath };
  }

  if (!options.dryRun) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(filePath, PI_EXTENSION_SCRIPT, { mode: 0o600 });
  }

  return { action: 'create', path: filePath };
}
