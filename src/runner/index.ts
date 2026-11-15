import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { $, type Subprocess } from 'bun';
import { launchArgumentError, options, parseArgs } from '../args';
import { showHelp } from '../help';
import { childExitCode } from './exitCode';
import { colorsToTailwind, queryColors, terminalBackground, terminalScheme } from './kittyColors';

function getElectronPath(): string {
  if (process.env.AWRIT_ELECTRON) return process.env.AWRIT_ELECTRON;
  try {
    return String(require('electron'));
  } catch {
    return 'electron';
  }
}
const { stdout } = process;

const RESET = '\x1b[0m';
const BOLD_GREEN = '\x1b[1;32m';
let launchArgs = process.argv.slice(2);

process.env.AWRIT_LAUNCHER ??= resolve(__dirname, '../../awrit');
process.env.AWRIT_SKILL_PATH ??= resolve(__dirname, '../../skills/awrit/SKILL.md');
process.env.AWRIT_KITTEN_PATH ??= resolve(__dirname, '../../kittens/awrit.py');
process.env.AWRIT_PLUGIN_ROOT ??= resolve(__dirname, '../..');
if (
  (launchArgs[0] === 'snapshot' || launchArgs[0] === 'capture') &&
  !launchArgs.includes('--help')
) {
  const root = resolve(__dirname, '../../');
  const result = await Bun.build({
    entrypoints: [join(root, 'src/presentation/captureMain.ts')],
    outdir: join(root, 'dist'),
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  if (!result.success) throw new Error('Failed to build isolated capture entry');
  process.env.AWRIT_CAPTURE_ENTRY = join(root, 'dist/captureMain.js');
  process.env.AWRIT_ELECTRON = getElectronPath();
}

const { isPresentationCommand } = await import('../presentation/args');
if (isPresentationCommand(launchArgs[0]) && process.env.AWRIT_CALLER_CWD) {
  process.chdir(process.env.AWRIT_CALLER_CWD);
}
// Clean up any remaining environment hints
delete process.env.AWRIT_CALLER_CWD;
const { runPresentationCli } = await import('../presentation/cli');
const presentationExit = await runPresentationCli(launchArgs);
if (presentationExit !== null) process.exit(presentationExit);

const argumentError = launchArgs.some((arg) => arg === '-h' || arg === '--help')
  ? undefined
  : launchArgumentError(launchArgs);
if (argumentError) {
  console.error(argumentError);
  process.exit(2);
}

if (launchArgs.length === 0 && stdout.isTTY && process.stdin.isTTY) {
  try {
    const { offerSetupOnce } = await import('../presentation/firstRun');
    const { selectPrompt } = await import('../presentation/prompt');
    const { getAppDataPath } = await import('../paths');
    const setupRan = await offerSetupOnce({
      dir: getAppDataPath(),
      interactive: true,
      select: async (prompt, choices) => {
        return selectPrompt({
          title: prompt,
          items: choices.map((c) => ({
            id: c,
            label: c,
            description:
              c === 'Set up now'
                ? 'Configure media tools and agent instructions'
                : c === 'Not now'
                  ? 'Skip for this session, ask next time'
                  : 'Do not ask again on startup',
          })),
        });
      },
      runSetup: async () => void (await runPresentationCli(['setup'])),
    });
    // If the setup wizard actually ran on first startup, exit cleanly.
    // If skipped ("Not now" or "Don't ask again") or already configured, proceed to browser.
    if (setupRan) {
      process.exit(0);
    }
  } catch (error) {
    console.error(`Setup offer skipped: ${error instanceof Error ? error.message : error}`);
  }
}

if (options.pick && !options.help) {
  try {
    const { pickArgs } = await import('../picker');
    const args = await pickArgs();
    if (!args) process.exit(0);
    delete options.pick;
    launchArgs = [...launchArgs.filter((arg) => arg !== '--pick'), ...args];
    Object.assign(options, parseArgs(launchArgs));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (options.help) {
  showHelp();
  process.exit(0);
}

if (options.version) {
  const version = (await $`git rev-parse --short HEAD`.quiet()).text().trim();
  if (stdout.isTTY) {
    stdout.write(`${BOLD_GREEN}awrit${RESET} ${version}\n`);
  } else {
    stdout.write(version);
  }
  process.exit(0);
}

if (options.deviceCommand !== undefined) {
  const { runAndroidCli } = await import('../adb/androidCli');
  const code = await runAndroidCli(options);
  if (code !== null) process.exit(code);
  // `view`: fall through and launch the shared browser owner.
}

const { server } = await import('./devServer');
const root = resolve(__dirname, '../../');
await $`mkdir -p ${root}/dist`.nothrow().quiet();

// Source launches should not rebundle unchanged Electron code on every review.
const runtimeHash = createHash('sha256');
const runtimeInputs = ['package.json', 'bun.lock'];
for await (const file of new Bun.Glob('**/*').scan({ cwd: join(root, 'src'), onlyFiles: true })) {
  runtimeInputs.push(`src/${file}`);
}
for (const file of runtimeInputs.sort()) {
  runtimeHash.update(file);
  runtimeHash.update(Buffer.from(await Bun.file(join(root, file)).arrayBuffer()));
}
const runtimeVersion = runtimeHash.digest('hex');
const runtimeStamp = Bun.file(join(root, 'dist/runtime-version'));
const runtimeOutputs = ['browserOwner/main.js', 'remote/pickerMain.js', 'remote/androidOwner.js', 'terminal/main.js', 'preload.js', 'content-preload.js'];
const runtimeComplete = (await Promise.all(runtimeOutputs.map(file => Bun.file(join(root, 'dist', file)).exists()))).every(Boolean);
if (options.rebuild || !runtimeComplete || !(await runtimeStamp.exists()) || (await runtimeStamp.text()) !== runtimeVersion) {
  const { success } = await Bun.build({
    entrypoints: [
      join(root, 'src/browserOwner/main.ts'),
      join(root, 'src/remote/pickerMain.ts'),
      join(root, 'src/remote/androidOwner.ts'),
      join(root, 'src/terminal/main.ts'),
      join(root, 'src/preload.js'),
      join(root, 'src/content-preload.js'),
    ],
    outdir: join(root, 'dist'),
    root: join(root, 'src'),
    target: 'node',
    format: 'cjs',
    sourcemap: 'inline',
    external: ['electron', '../config.js', '*.node'],
  });

  if (!success) {
    console.error('Failed to build');
    process.exit(1);
  }
  await runtimeStamp.write(runtimeVersion);
}

const toolbarInputs = [
  join(root, 'package.json'),
  join(root, 'bun.lock'),
  join(root, 'src/runner/package.json'),
  join(root, 'src/runner/kittyColors.ts'),
  join(root, 'src/runner/ports.ts'),
  join(root, 'src/runner/vite.config.ts'),
  join(root, 'src/debounce.ts'),
  join(root, 'src/toolbar/index.html'),
  join(root, 'src/toolbar/tsconfig.json'),
];
for await (const file of new Bun.Glob('**/*').scan({
  cwd: join(root, 'src/toolbar/src'),
  onlyFiles: true,
})) {
  toolbarInputs.push(join(root, 'src/toolbar/src', file));
}

const hash = createHash('sha256');
for (const file of toolbarInputs.sort()) {
  hash.update(file.slice(root.length));
  hash.update(Buffer.from(await Bun.file(file).arrayBuffer()));
}
const toolbarVersion = `${require(join(root, 'package.json')).version}:${hash.digest('hex')}`;
const distVersion = Bun.file(join(root, 'dist/version'));

// Query each launch: cached toolbar assets must not pin another terminal's theme.
const needsToolbarBuild = options.rebuild || !(await distVersion.exists()) || (await distVersion.text()) !== toolbarVersion;
{
  let didQueryColors = false;
  for (let tries = 0; !didQueryColors && tries < 3; tries++) {
    try {
      process.stdin.setRawMode(true);
      const colors = await queryColors();
      process.stdin.setRawMode(false);
      if (!colors) {
        console.error('Failed to query terminal colors');
      } else {
        process.env.AWRIT_TERMINAL_SCHEME = terminalScheme(colors);
        const background = terminalBackground(colors);
        if (background) process.env.AWRIT_TERMINAL_BACKGROUND = background;
        if (needsToolbarBuild) await Bun.write(join(root, 'dist/kitty.css'), colorsToTailwind(colors));
        didQueryColors = true;
      }
    } catch {
      console.error('Failed to query terminal colors');
    }
  }
  // TODO: figure out why this isn't reliable for some users
  if (!didQueryColors) {
    // empty placeholder required for building in case of failure
    process.env.AWRIT_TERMINAL_SCHEME = 'dark';
    if (needsToolbarBuild) await Bun.write(join(root, 'dist/kitty.css'), '');
  }
}

if (needsToolbarBuild) {
  console.error('building toolbar');
  try {
    await $`bun ${join(root, 'node_modules/vite/bin/vite.js')} build`.cwd(join(root, 'src/runner'));
  } catch (e) {
    const e_ = e as any;
    console.error(e_.stderr.toString());
    process.exit(1);
  }

  await distVersion.write(toolbarVersion);
}

const children: [string, Subprocess][] = [];
const isDev = options.dev;

if (isDev) {
  await server.listen();
}

const electronPath = getElectronPath();
process.env.AWRIT_ELECTRON = electronPath;
process.env.AWRIT_OWNER_ENTRY = join(root, 'dist/browserOwner/main.js');

const terminalClientEntry = join(root, 'dist/terminal/main.js');
const clientArgs = [process.execPath, terminalClientEntry, ...launchArgs];

children.push([
  'terminal-client',
  Bun.spawn(clientArgs, {
    env: {
      ...process.env,
      AWRIT_ELECTRON: String(electronPath),
      AWRIT_OWNER_ENTRY: join(root, 'dist/browserOwner/main.js'),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
    serialization: 'json',
    windowsHide: true,
    onExit(_proc, exitCode, signalCode) {
      destroyAllSubprocesses(childExitCode(exitCode, signalCode));
    },
  }),
]);

function destroySubprocess(name: string, child: Subprocess) {
  if (child.killed) return;
  console.error('destroying', name);
  child.kill();
}

function destroyAllSubprocesses(code = 0) {
  for (const [name, child] of children) {
    destroySubprocess(name, child);
  }
  if (isDev) {
    console.error('stopping dev server');
    server.close();
  }
  process.exit(code);
}

// process.on passes the signal name, so wrap to keep a clean exit on Ctrl-C.
process.on('SIGINT', () => destroyAllSubprocesses());
process.on('SIGTERM', () => destroyAllSubprocesses());
