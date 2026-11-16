import { parsePresentationArgs } from './args';
import type { CapabilitiesReport } from './capabilities';
import { CAPTURE_NEXT_STEP, contextGuidance, OVERLAY_NEXT_STEP } from './contextGuidance';
import { presentationHelp } from './help';
import type { ToggleOverlayResult } from './overlayToggle';
import { resolvePresentationTarget } from './target';
import { reportCliError, UsageError } from './usageError';

/** Guidance is only useful in Kitty with a control endpoint or an adb device. */
async function contextUsable(report: CapabilitiesReport): Promise<boolean> {
  if (!report.detected.inKitty) return false;
  if (report.detected.controlEndpoint) return true;
  const { listConnectedAdbDevices } = await import('../adb/androidManager');
  return (await listConnectedAdbDevices()).length > 0;
}

function describeOverlay(o: ToggleOverlayResult): string {
  if (o.action === 'opened') {
    const state = o.viewerRunning
      ? 'viewer running'
      : 'viewer process not detected yet (may still be starting)';
    return `${o.resumed ? 'Resumed' : 'Opened'} overlay for ${o.target} (window ${o.id}, ${state})`;
  }
  if (o.action === 'already-open') {
    return `Overlay for ${o.target} is already open (window ${o.id})`;
  }
  return JSON.stringify(o);
}

const TOOL_HELP = `Usage: awrit tool <name|list> [JSON] [--pane ID]

Control the page in the open Awrit viewer. "awrit tool list" shows each tool and its inputs.
Example: awrit tool click '{"selector":"#go"}'
`;

function kittyNote(
  receipt: { changes: { path: string; action: string }[] } | undefined,
  dryRun: boolean,
  uninstall: boolean,
): string {
  const actions = uninstall ? ['remove', 'update'] : ['create', 'update'];
  const done = receipt?.changes.filter((c) => actions.includes(c.action)) ?? [];
  if (done.length === 0) return '';
  const verb = uninstall ? (dryRun ? 'Would remove' : 'Removed') : dryRun ? 'Would install' : 'Installed';
  return `\n${verb} Kitty files: ${done.map((c) => c.path).join(', ')}`;
}

function manualKittyNote(receipt?: { changes: { kind: string; path: string; action: string; warning?: string }[] }): string {
  const conf = receipt?.changes.find((c) => c.kind === 'kitty-conf' && c.action === 'manual');
  return conf ? `\nWarning: ${conf.warning ?? `Could not edit ${conf.path}; remove the include awrit.conf block from its managed source.`}` : '';
}

async function runKittySetup(args: { dryRun: boolean; uninstall: boolean }) {
  const { setupKitty } = await import('./kittySetup');
  const { homedir } = await import('node:os');
  const path = await import('node:path');
  const launcher = process.env.AWRIT_LAUNCHER;
  const kittenPath = process.env.AWRIT_KITTEN_PATH;
  if (!launcher || !kittenPath) throw new Error('Kitty setup assets are missing');
  const configDir =
    process.env.KITTY_CONFIG_DIRECTORY ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'kitty');
  const { readDesignKey } = await import('../designKey');
  return setupKitty({
    designKey: readDesignKey(),
    configDir,
    launcher,
    kittenPath,
    dryRun: args.dryRun,
    uninstall: args.uninstall,
  });
}

export async function runPresentationCli(argv: string[]): Promise<number | null> {
  // Hidden: the SSH runtime calls this to pipe one channel to the supervisor socket.
  if (argv[0] === 'remote-bridge') {
    const channelIndex = argv.indexOf('--channel');
    const channel = channelIndex >= 0 ? argv[channelIndex + 1] : undefined;
    if (!channel) {
      process.stderr.write('awrit remote-bridge: --channel <control|media|bulk> is required\n');
      return 2;
    }
    const kindIndex = argv.indexOf('--kind');
    const kind = kindIndex >= 0 ? argv[kindIndex + 1] : undefined;
    const {
      parseRemoteChannel,
      parseRemoteOwnerKind,
      runBridge,
      remoteOwnerEntry,
      remoteAndroidOwnerEntry,
    } = await import('../remote/bridge');
    const { supervisorDir, supervisorSocketPath } = await import('../remote/supervisor');
    const { ownerBuildIdentity } = await import('../browserOwner/build');
    try {
      parseRemoteChannel(channel);
      parseRemoteOwnerKind(kind ?? 'browser');
    } catch (error) {
      process.stderr.write(
        `awrit remote-bridge: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
    let build: string;
    try {
      const entry =
        kind === 'android'
          ? remoteAndroidOwnerEntry(process.env, process.argv[1])
          : remoteOwnerEntry(process.env, process.argv[1]);
      build = ownerBuildIdentity(entry);
    } catch (error) {
      process.stderr.write(`awrit remote-bridge: cannot read the owner build: ${String(error)}\n`);
      return 1;
    }
    return runBridge({
      channel,
      kind,
      socketPath: supervisorSocketPath(supervisorDir(build)),
      stdin: process.stdin,
      stdout: process.stdout,
    });
  }
  if (argv[0] === 'status') {
    const STATUS_USAGE = 'Usage: awrit status [--json]';
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(
        'Usage: awrit status [--json]\n\nShows the Awrit viewer in this terminal window and what to do next, as JSON.\n',
      );
      return 0;
    }
    const extra = argv.slice(1).find((arg) => arg !== '--json');
    // Status always prints JSON, so --json only keeps scripted callers explicit.
    if (extra !== undefined) {
      const reason =
        extra.startsWith('-') ? `Unknown option: ${extra}` : `Unexpected argument: ${extra}`;
      return reportCliError(new UsageError(`${reason}. ${STATUS_USAGE}`), argv.includes('--json'));
    }
    const { runStatusCommand } = await import('./toolClient');
    return runStatusCommand();
  }
  if (argv[0] === 'tool') {
    // Tool input is JSON, which the shared flag parser would reject, so it is handled here.
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(TOOL_HELP);
      return 0;
    }
    const { runToolCommand } = await import('./toolClient');
    return runToolCommand(argv.slice(1));
  }
  try {
    const args = parsePresentationArgs(argv);
    if (!args) return null;
    // Remote view runs in this pane; only this command loads src/remote/.
    if (args.command === 'show' && args.host && !args.help) {
      if (args.forward !== undefined) {
        const { forwardConsentText, validateForwardUrl } = await import('../remote/forward');
        try {
          validateForwardUrl(args.target ?? '', args.forward);
        } catch (error) {
          throw new UsageError(error instanceof Error ? error.message : String(error));
        }
        // Consent is required, and --yes is rejected for show. Ask before any terminal setup.
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          throw new Error('Port forwarding needs an interactive terminal to ask first.');
        const { askYes } = await import('../remote/resolveRuntime');
        process.stdout.write(`${forwardConsentText(args.host, args.target ?? '', args.forward)}\n`);
        if (!(await askYes('Forward this port? [y/N] '))) return 1;
      } else {
        const { isLoopbackUrl } = await import('../remote/forward');
        // The remote browser's localhost is its host, not this machine.
        if (isLoopbackUrl(args.target ?? ''))
          process.stderr.write(
            'awrit: localhost here means the remote host. To reach a service on this machine, use --forward <port>.\n',
          );
      }
      const { resolveRemoteRuntime } = await import('../remote/resolveRuntime');
      const runtimePath = await resolveRemoteRuntime(args.host, args.remoteAwrit);
      // No runtime, or the user declined the install: the reason is already printed.
      if (runtimePath === undefined) return 1;
      const { runRemoteShow } = await import('../remote/client');
      return runRemoteShow({
        alias: args.host,
        url: args.target ?? '',
        runtimePath,
        ...(args.forward !== undefined ? { forward: args.forward } : {}),
        ...(args.session !== undefined ? { session: args.session } : {}),
      });
    }
    if (
      args.target &&
      !args.help &&
      ['show', 'overlay', 'snapshot', 'capture'].includes(args.command)
    ) {
      const { renderMarkdownTarget } = await import('./markdownPage');
      const { renderCodeTarget } = await import('./codePage');
      args.target = await renderCodeTarget(await renderMarkdownTarget(args.target));
    }
    if (args.help) {
      process.stdout.write(presentationHelp(args.command));
      return 0;
    }
    if (args.command === 'capabilities') {
      const { detectCapabilities } = await import('./capabilities');
      const report = await detectCapabilities();
      process.stdout.write(JSON.stringify(report, null, args.json ? undefined : 2) + '\n');
      return 0;
    }
    if (args.command === 'context') {
      const { detectCapabilities } = await import('./capabilities');
      const report = await detectCapabilities();
      if (!(await contextUsable(report))) {
        if (args.json && !args.claude)
          process.stdout.write(JSON.stringify({ guidance: '', capabilities: report }) + '\n');
        return 0;
      }
      const { keyLabel, readDesignKey } = await import('../designKey');
      const guidance = contextGuidance(
        args.harness ?? (args.claude ? 'claude' : 'generic'),
        args.browsing,
        keyLabel(readDesignKey()),
      );
      // Session start is the one moment Claude gets context for free; include this window's viewer state.
      const status = args.claude
        ? await import('./toolClient').then(({ readStatus }) => readStatus()).catch(() => undefined)
        : undefined;
      const sessionContext = status ? `${guidance}\nAwrit status now: ${status.next}` : guidance;
      process.stdout.write(
        args.claude
          ? JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: sessionContext,
              },
            }) + '\n'
          : args.json
            ? JSON.stringify({ guidance, capabilities: report }) + '\n'
            : guidance + '\n',
      );
      return 0;
    }
    if (args.command === 'setup' && args.target === undefined) {
      if (args.claude) throw new UsageError('--claude is only for setup agents');
      const { setupAll, formatSetupSummary } = await import('./setupFlow');
      const { pluginRoot } = await import('./pluginSetup');
      const { checkboxPrompt } = await import('./prompt');
      const { homedir } = await import('node:os');
      const launcher = process.env.AWRIT_LAUNCHER;
      const skillPath = process.env.AWRIT_SKILL_PATH;
      if (!launcher || !skillPath)
        throw new Error('Setup assets are missing; run through the Awrit launcher');
      let root: string | undefined;
      try {
        root = pluginRoot(process.env);
      } catch {
        // only fatal if the plugin item is selected
      }
      const selectMany = async (
        promptText: string,
        _choices: string[],
        options?: { preselectAll?: boolean; items?: import('./setupFlow').PromptItem[] },
      ) => {
        if (!options?.items) {
          const { selectMany: fzfSelectMany } = await import('../picker');
          return fzfSelectMany(promptText, _choices, options);
        }
        return checkboxPrompt({
          title: promptText === 'Remove' ? 'Select agents to remove' : 'Select agents to configure',
          items: options.items,
        });
      };
      const receipt = await setupAll({
        home: homedir(),
        env: process.env,
        launcher,
        skillPath,
        root,
        dryRun: args.dryRun,
        yes: args.yes,
        uninstall: args.uninstall,
        browsing: args.browsing,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        selectMany,
        askText: async (title, defaultValue) => {
          const { textPrompt } = await import('./prompt');
          return textPrompt({ title, defaultValue });
        },
      });
      // Kitty files and the include block follow the agent setup, in both directions.
      const kittyRemoval = await runKittySetup(args);
      // Saved data is deleted only on the explicit --purge.
      let purged: string | undefined;
      if (args.uninstall && args.purge) {
        const { rmSync } = await import('node:fs');
        const { getAppDataPath } = await import('../paths');
        purged = getAppDataPath();
        if (!args.dryRun) rmSync(purged, { recursive: true, force: true });
      }
      process.stdout.write(
        (args.json ? JSON.stringify({ ...receipt, kitty: kittyRemoval, purged }) : formatSetupSummary(receipt) +
              (purged ? `\n${args.dryRun ? 'Would delete' : 'Deleted'} saved data: ${purged}` : '') +
              kittyNote(kittyRemoval, args.dryRun, args.uninstall) +
              manualKittyNote(kittyRemoval)) + '\n',
      );
      return 0;
    }
    if (args.command === 'setup' && args.target === 'kitty') {
      if (args.claude) throw new UsageError('--claude is only for setup agents');
      const receipt = await runKittySetup(args);
      process.stdout.write(JSON.stringify(receipt, null, args.json ? undefined : 2) + '\n');
      return 0;
    }
    if (args.command === 'setup' && args.target === 'plugins') {
      if (args.claude || args.uninstall)
        throw new UsageError('--claude/--uninstall do not apply to plugins');
      const { setupPlugins, pluginRoot } = await import('./pluginSetup');
      const { select } = await import('../picker');
      const receipt = await setupPlugins({
        root: pluginRoot(process.env),
        dryRun: args.dryRun,
        yes: args.yes,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        select,
      });
      process.stdout.write(JSON.stringify(receipt, null, args.json ? undefined : 2) + '\n');
      return 0;
    }
    if (args.command === 'setup' && args.target === 'agents') {
      if (!args.claude)
        throw new UsageError(
          'Specify --claude for agent setup; other harness setup is not implemented',
        );
      const { setupClaudeDiscovery } = await import('./discovery');
      const { homedir } = await import('node:os');
      const launcher = process.env.AWRIT_LAUNCHER;
      const skillPath = process.env.AWRIT_SKILL_PATH;
      if (!launcher || !skillPath)
        throw new Error('Setup assets are missing; run through the Awrit launcher');
      const receipt = setupClaudeDiscovery({
        home: homedir(),
        launcher,
        skillPath,
        dryRun: args.dryRun,
        uninstall: args.uninstall,
        browsing: args.browsing,
      });
      process.stdout.write(JSON.stringify(receipt, null, args.json ? undefined : 2) + '\n');
      return 0;
    }
    if (args.command === 'snapshot') {
      const { captureSnapshot } = await import('./capture');
      const entryPath = process.env.AWRIT_CAPTURE_ENTRY;
      if (!entryPath) throw new Error('Snapshot entry is missing; run through the Awrit launcher');
      const receipt = await captureSnapshot({
        target: args.target ?? '',
        out: args.out ?? '',
        viewport: args.viewport,
        overwrite: args.overwrite,
        waitMs: args.waitMs,
        waitSelector: args.waitSelector,
        entryPath,
        electronPath: process.env.AWRIT_ELECTRON,
      });
      process.stdout.write(
        args.json
          ? JSON.stringify(receipt) + '\n'
          : `Snapshot saved to ${receipt.outPath} (${receipt.width}x${receipt.height})\n`,
      );
      return 0;
    }
    // One command for agents: a local recording given to `show` plays in the video overlay.
    if (
      args.command === 'show' &&
      (args.mode === 'auto' || args.mode === 'overlay') &&
      args.target &&
      /\.(mp4|mov|m4v|webm)$/i.test(args.target.split(/[?#]/)[0]) &&
      resolvePresentationTarget(args.target).kind === 'file'
    ) {
      args.command = 'video';
      args.mode = 'overlay';
    }
    if (
      args.command === 'show' &&
      args.mode === 'auto' &&
      !args.json &&
      args.target &&
      process.stdout.isTTY &&
      process.env.AWRIT_TERMINAL_OWNER === 'shell'
    ) {
      const { validateImageFile } = await import('./images');
      const { resolvePresentationTarget } = await import('./target');
      const target = resolvePresentationTarget(args.target);
      if (target.kind === 'file') {
        try {
          validateImageFile(target.path);
          args.mode = 'inline';
        } catch (error) {
          if (
            !(error instanceof Error && 'code' in error && error.code === 'INVALID_IMAGE_SIGNATURE')
          )
            throw error;
        }
      }
    }
    if (args.command === 'inline' || (args.command === 'show' && args.mode === 'inline')) {
      const { assertTerminalEligibility, presentInlineImage, presentSideBySideImage } =
        await import('./images');
      if (args.json) throw new UsageError('Inline graphics cannot use JSON stdout');
      const ownedTerminal = process.env.AWRIT_TERMINAL_OWNER === 'shell';
      assertTerminalEligibility({ ownedTerminal });
      const { getWindowSize } = await import('awrit-native-rs');
      const size = getWindowSize();
      const options = {
        ownedTerminal,
        width: args.width,
        height: args.height,
        dimensions: {
          columns: size.cols,
          rows: size.rows,
          pixelWidth: size.width,
          pixelHeight: size.height,
        },
      };
      const present = (imagePath: string) =>
        args.text !== undefined
          ? presentSideBySideImage({
              ...options,
              imagePath,
              text: args.text,
              columns: args.columns,
              layout: args.layout,
            })
          : presentInlineImage({ ...options, imagePath });
      const { resolvePresentationTarget } = await import('./target');
      const target = resolvePresentationTarget(args.target ?? '');
      if (target.kind !== 'file')
        throw new UsageError('inline requires a local image; snapshot HTML/URLs first');
      await present(target.path);
      return 0;
    }
    if (args.command === 'show' && args.mode === 'overlay') {
      const { toggleOverlay } = await import('./overlayToggle');
      const { resolveKittyContext } = await import('./kittyDiscovery');
      const ctx = await resolveKittyContext({ timeoutMs: 40 });
      const sourceWindowId = ctx?.sourceWindowId ?? process.env.KITTY_WINDOW_ID;
      if (!sourceWindowId) {
        throw new Error('Active Kitty window could not be determined for overlay mode');
      }
      const outcome = await toggleOverlay({
        sourceWindowId,
        endpoint: ctx?.endpoint,
        target: args.target ? resolvePresentationTarget(args.target).url : undefined,
        text: args.text,
        layout: args.layout,
        columns: args.columns,
      });
      if (args.json)
        process.stdout.write(
          JSON.stringify({
            ...outcome,
            ...(args.text !== undefined ? { surface: 'companion' } : {}),
          }) + '\n',
        );
      else process.stdout.write(`${describeOverlay(outcome)}\n`);
      return 0;
    }
    if (args.command === 'show' && args.mode !== 'inline') {
      const { resolvePresentationTarget } = await import('./target');
      const target = args.target ? resolvePresentationTarget(args.target) : undefined;

      // Self-healing: resolve live Kitty context if env variables are stale or missing
      const { resolveKittyContext } = await import('./kittyDiscovery');
      const ctx = await resolveKittyContext({ timeoutMs: 40 });
      const resolvedEndpoint = ctx?.endpoint ?? process.env.KITTY_LISTEN_ON;
      const explicitWindowId = process.env.KITTY_WINDOW_ID;
      const resolvedSourceWindowId = explicitWindowId
        ? explicitWindowId
        : ctx?.sourceWindowId
          ? String(ctx.sourceWindowId)
          : '';

      // Fast-path: Check if an active viewer is already open and can be navigated via IPC
      const { getSocketPath, isSocketAlive } = await import('../ipc/socketServer');
      const sockPath = getSocketPath();

      if (target && (await isSocketAlive(sockPath, 150))) {
        type NavigationOutcome =
          | { outcome: 'navigated'; url: string; kittyWindowId?: string | number }
          | { outcome: 'no-match' };

        const net = await import('node:net');
        const client = net.connect(sockPath);
        const { randomBytes } = await import('node:crypto');
        const reqId = randomBytes(4).toString('hex');

        const navOutcome = await new Promise<NavigationOutcome>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;

          const clearNavTimer = () => {
            if (timer !== undefined) {
              clearTimeout(timer);
              timer = undefined;
            }
          };

          const cleanupAndReject = (err: Error) => {
            if (settled) return;
            settled = true;
            clearNavTimer();
            client.destroy();
            reject(err);
          };

          const cleanupAndResolve = (result: NavigationOutcome) => {
            if (settled) return;
            settled = true;
            clearNavTimer();
            client.destroy();
            resolve(result);
          };

          timer = setTimeout(() => {
            cleanupAndReject(
              new Error(
                'Navigation request timed out after 10000ms: outcome unknown; check existing preview before retry',
              ),
            );
          }, 10000);

          client.on('connect', () => {
            const navPayload: Record<string, unknown> = {
              type: 'viewer:navigate',
              requestId: reqId,
              target: target.url,
            };
            if (resolvedSourceWindowId) {
              navPayload.sourceWindowId = resolvedSourceWindowId;
            }
            client.write(JSON.stringify(navPayload) + '\n');
          });

          let buf = '';
          client.on('data', (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg: unknown = JSON.parse(line);
                if (
                  typeof msg === 'object' &&
                  msg !== null &&
                  'type' in msg &&
                  msg.type === 'viewer:navigate:response' &&
                  'requestId' in msg &&
                  msg.requestId === reqId
                ) {
                  const record = msg as Record<string, unknown>;
                  if (record.ok !== true) {
                    cleanupAndReject(
                      new Error(
                        typeof record.error === 'string'
                          ? record.error
                          : record.ok === false
                            ? 'Navigation failed on viewer'
                            : 'Invalid navigation response: missing or non-boolean ok',
                      ),
                    );
                    return;
                  }
                  const data = record.data;
                  if (typeof data !== 'object' || data === null) {
                    cleanupAndReject(
                      new Error('Invalid navigation response: data is not an object'),
                    );
                    return;
                  }
                  const dataRec = data as Record<string, unknown>;
                  if (typeof dataRec.navigated !== 'boolean') {
                    cleanupAndReject(
                      new Error('Invalid navigation response: missing navigated boolean'),
                    );
                    return;
                  }

                  if (dataRec.navigated) {
                    if (typeof dataRec.url !== 'string') {
                      cleanupAndReject(
                        new Error('Invalid navigation response: missing url string'),
                      );
                      return;
                    }
                    cleanupAndResolve({
                      outcome: 'navigated',
                      url: dataRec.url,
                      kittyWindowId:
                        typeof dataRec.kittyWindowId === 'string' ||
                        typeof dataRec.kittyWindowId === 'number'
                          ? dataRec.kittyWindowId
                          : undefined,
                    });
                    return;
                  }

                  if (typeof dataRec.reason !== 'string' || !dataRec.reason.trim()) {
                    cleanupAndReject(new Error('Invalid navigation response: missing reason'));
                    return;
                  }

                  if (dataRec.reason === 'no-matching-viewer') {
                    cleanupAndResolve({ outcome: 'no-match' });
                    return;
                  }

                  cleanupAndReject(new Error(`Navigation refused: ${dataRec.reason}`));
                  return;
                }
              } catch (parseErr) {
                cleanupAndReject(
                  parseErr instanceof Error ? parseErr : new Error(String(parseErr)),
                );
                return;
              }
            }
          });

          client.on('error', (err) => {
            cleanupAndReject(err instanceof Error ? err : new Error(String(err)));
          });

          client.on('close', () => {
            cleanupAndReject(new Error('Connection closed before navigation response'));
          });

          client.on('end', () => {
            cleanupAndReject(new Error('Connection ended before navigation response'));
          });
        });

        if (navOutcome.outcome === 'navigated') {
          const viewerId = navOutcome.kittyWindowId
            ? parseInt(String(navOutcome.kittyWindowId), 10)
            : undefined;

          // Optionally focus the viewer window if running in Kitty
          if (viewerId) {
            try {
              const { focusKittyWindow } = await import('./kitty');
              await focusKittyWindow(viewerId, { endpoint: resolvedEndpoint });
            } catch {}
          }

          const receipt = {
            id: viewerId ?? 0,
            source: resolvedSourceWindowId ? parseInt(resolvedSourceWindowId, 10) : 0,
            mode: 'split',
            readiness: 'navigated',
            url: navOutcome.url,
          };

          if (args.json) {
            process.stdout.write(JSON.stringify(receipt) + '\n');
          } else {
            process.stdout.write(
              `Navigated existing preview to ${receipt.url}${receipt.id ? ` (Kitty window ${receipt.id})` : ''}\n`,
            );
          }
          return 0;
        }

        // navOutcome.outcome === 'no-match':
        // Explicit structured no-match permits fallback to launching a new window below.
      }

      const { launchKitty, buildKittyLaunchSpec } = await import('./kitty');
      const launcher = process.env.AWRIT_LAUNCHER;
      if (!launcher) throw new Error('Awrit launcher path is missing');
      const spec = buildKittyLaunchSpec({ launcher, target });
      if (args.text !== undefined) {
        spec.argv.push(
          '--presentation-json',
          JSON.stringify({ text: args.text, layout: args.layout, columns: args.columns }),
        );
      }

      const receipt = await launchKitty({
        sourceWindowId: resolvedSourceWindowId,
        endpoint: resolvedEndpoint,
        mode: args.mode === 'companion' ? 'tab' : args.mode,
        launchSpec: spec,
      });
      if (args.json)
        process.stdout.write(
          JSON.stringify({
            ...receipt,
            ...(args.text !== undefined ? { surface: 'companion' } : {}),
          }) + '\n',
        );
      else
        process.stdout.write(
          `Opened ${receipt.mode} preview (${receipt.readiness}, Kitty window ${receipt.id})\n`,
        );
      return 0;
    }
    if (args.command === 'overlay') {
      const { toggleOverlay } = await import('./overlayToggle');
      const { resolveKittyContext } = await import('./kittyDiscovery');
      const ctx = await resolveKittyContext({ timeoutMs: 40 });
      const sourceWindowId = ctx?.sourceWindowId ?? process.env.KITTY_WINDOW_ID;
      if (!sourceWindowId) {
        throw new Error('KITTY_WINDOW_ID environment variable is required for overlay toggle');
      }
      if (args.text !== undefined) {
        const { updateOverlayText } = await import('./overlayText');
        await updateOverlayText({ sourceWindowId, text: args.text });
        process.stdout.write(
          args.json
            ? JSON.stringify({
                action: 'text-updated',
                next_step: 'Text beside the video changed; playback was not interrupted.',
              }) + '\n'
            : 'Overlay text updated.\n',
        );
        return 0;
      }
      const outcome = await toggleOverlay({
        sourceWindowId,
        endpoint: ctx?.endpoint,
        target: args.target ? resolvePresentationTarget(args.target).url : undefined,
        close: args.close,
        status: args.status,
      });

      if (args.json) {
        process.stdout.write(
          JSON.stringify({ ...outcome, next_step: OVERLAY_NEXT_STEP[outcome.action] }) + '\n',
        );
      } else {
        if (outcome.action === 'opened') {
          process.stdout.write(`${describeOverlay(outcome)}\n`);
        } else if (outcome.action === 'already-open') {
          process.stdout.write(
            `Overlay for ${outcome.target} is already open (window ${outcome.id})\n`,
          );
        } else if (outcome.action === 'closed') {
          process.stdout.write(`Closed overlay (window ${outcome.previousId})\n`);
        } else if (outcome.action === 'already-closed') {
          process.stdout.write('Overlay is already closed\n');
        } else if (outcome.action === 'status') {
          process.stdout.write(
            outcome.open
              ? `Overlay is open for ${outcome.target} (window ${outcome.id})\n`
              : 'Overlay is closed\n',
          );
        }
      }
      return 0;
    }
    if (args.command === 'video') {
      if (!args.target) throw new UsageError('video requires a local recording path');
      if (args.mode === 'overlay') {
        const sourceWindowId = process.env.KITTY_WINDOW_ID;
        if (!sourceWindowId) throw new Error('KITTY_WINDOW_ID is required for video overlay');
        const { createVideoPage } = await import('./videoPage');
        const { toggleOverlay } = await import('./overlayToggle');
        const page = await createVideoPage(args.target, args.text);
        const outcome = await (async () => {
          try {
            return await toggleOverlay({
              sourceWindowId,
              target: resolvePresentationTarget(page).url,
            });
          } catch (error) {
            const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
            await fs.rm(path.dirname(page), { recursive: true, force: true });
            throw error;
          }
        })();
        if (args.json)
          process.stdout.write(
            JSON.stringify({ ...outcome, next_step: OVERLAY_NEXT_STEP[outcome.action] }) + '\n',
          );
        else process.stdout.write(`Video overlay ${outcome.action}. Press Escape to return.\n`);
        return 0;
      }
      const { prepareVideo } = await import('./video');
      const preview = await prepareVideo(args.target);
      process.stdout.write(
        args.json
          ? JSON.stringify({
              ...preview,
              marker: `awrit-video:${JSON.stringify(preview)}`,
              next_step:
                'Frames prepared, not playing. In Claude with awrit-chat, put marker on its own line in your reply to play this prepared recording; do not call the video tool again. Other harnesses can share source or poster, but cannot play this marker inline.',
            }) + '\n'
          : `Prepared recording (${preview.duration.toFixed(1)}s, ${preview.count} frames): ${preview.poster}\nUse the awrit-chat video tool or /awrit-video to play it in chat.\n`,
      );
      return 0;
    }
    if (args.command === 'capture') {
      const { createFrozenCapture } = await import('./collaborativeCapture');
      let regionBox: { x: number; y: number; width: number; height: number } | undefined;
      if (args.region) {
        const parts = args.region.split(',').map((p) => Number(p.trim()));
        if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
          throw new UsageError('--region must be formatted as X,Y,WIDTH,HEIGHT');
        }
        regionBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
      const parsedWid = process.env.KITTY_WINDOW_ID ? Number(process.env.KITTY_WINDOW_ID) : NaN;
      const sourceWindowId =
        Number.isSafeInteger(parsedWid) && parsedWid > 0 ? parsedWid : undefined;
      const capture = await createFrozenCapture({
        target: args.target ? resolvePresentationTarget(args.target).url : undefined,
        region: regionBox,
        comment: args.comment,
        waitMs: args.waitMs,
        waitSelector: args.waitSelector,
        sourceWindowId,
      });

      if (args.json) {
        process.stdout.write(JSON.stringify({ ...capture, next_step: CAPTURE_NEXT_STEP }) + '\n');
      } else {
        process.stdout.write(
          `Captured ${capture.width}x${capture.height} image (${capture.id}):\n${capture.marker}\n`,
        );
      }
      return 0;
    }
    throw new Error(`${args.command} presentation is not implemented yet`);
  } catch (error) {
    return reportCliError(error, argv.includes('--json'));
  }
}
