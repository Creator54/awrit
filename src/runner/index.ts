import { possibleOptions, options } from '../args';
import { $, type Subprocess } from 'bun';
import electronPath from 'electron';
import { resolve, join } from 'node:path';
import fs from 'node:fs';
import { colorsToTailwind, queryColors } from './kittyColors';
import { server } from './devServer';
import { getDisplayScale } from '../dpi';
import { getLogPath } from '../paths';

const { stdout } = process;

const RESET = '\x1b[0m';
const DIM_WHITE = '\x1b[0;2m';
const BOLD_GREEN = '\x1b[1;32m';
const BOLD_WHITE = '\x1b[1m';

export function showHelp() {
  stdout.write(RESET);
  stdout.write(`Usage: ${BOLD_GREEN}awrit${RESET} ${DIM_WHITE}[options] [url]${RESET}\n\n`);
  stdout.write('Options:\n');
  for (const [key, value] of Object.entries(possibleOptions)) {
    if ('arg' in value) {
      stdout.write(`  ${DIM_WHITE}[${key}]${RESET}: ${value.description}\n`);
    } else {
      stdout.write(
        `  ${BOLD_WHITE}-${value.short}${RESET}, ${BOLD_WHITE}--${key}${RESET}: ${value.description}\n`,
      );
    }
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

const root = resolve(__dirname, '../../');
await $`mkdir -p ${root}/dist`.nothrow().quiet();

{
  const { success } = await Bun.build({
    entrypoints: [join(root, 'src/index.ts'), join(root, 'src/preload.js'), join(root, 'src/content-preload.js')],
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
}

const version = require(join(root, 'package.json')).version;
const distVersion = Bun.file(join(root, 'dist/version'));

if (!(await distVersion.exists()) || (await distVersion.text()) !== version || options.rebuild) {
  console.error('building toolbar');
  let didQueryColors = false;
  for (let tries = 0; !didQueryColors && tries < 3; tries++) {
    try {
      process.stdin.setRawMode(true);
      const colors = await queryColors();
      process.stdin.setRawMode(false);
      if (!colors) {
        console.error('Failed to query terminal colors');
      } else {
        await Bun.write(join(root, 'dist/kitty.css'), colorsToTailwind(colors));
        didQueryColors = true;
      }
    } catch {
      console.error('Failed to query terminal colors');
    }
  }
  // TODO: figure out why this isn't reliable for some users
  if (!didQueryColors) {
    // empty placeholder required for building in case of failure
    await Bun.write(join(root, 'dist/kitty.css'), '');
  }

  try {
    await $`bun ${join(root, 'node_modules/vite/bin/vite.js')} build`.cwd(join(root, 'src/runner'));
  } catch (e) {
    const e_ = e as any;
    console.error(e_.stderr.toString());
    process.exit(1);
  }

  distVersion.write(version);
}

const children: [string, Subprocess][] = [];
const isDev = options.dev;

if (isDev) {
  await server.listen();
}

const args = [
  // electronPath is not the electron module, it's the path to the electron executable, despite what TS thinks
  electronPath as unknown as string,
  join(root, 'dist/index.js'),
  '--high-dpi-support=1',
];

// Kitty respects the virtual scale size, while other terminals respect the physical scale size, which confuses things
const forcedDisplayScale = getDisplayScale();
if (forcedDisplayScale) {
  args.push(`--force-device-scale-factor=${forcedDisplayScale}`);
}
args.push(...process.argv.slice(2));

const logPath = getLogPath();
try {
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }
} catch {}
const logFd = fs.openSync(logPath, 'a');

children.push([
  'electron',
  Bun.spawn(
    // electronPath is not the electron module, it's the path to the electron executable, despite what TS thinks
    args,
    {
      stdio: ['inherit', 'inherit', logFd],
      serialization: 'json',
      ipc(message, subprocess) {
        // TODO: do cool stuff with IPC between bun and the electron process
      },
      windowsHide: true,
      onExit() {
        destroyAllSubprocesses();
      },
    },
  ),
]);

function destroySubprocess(name: string, child: Subprocess) {
  if (child.killed) return;
  console.error('destroying', name);
  child.kill();
}

function destroyAllSubprocesses() {
  for (const [name, child] of children) {
    destroySubprocess(name, child);
  }
  if (isDev) {
    console.error('stopping dev server');
    server.close();
  }
  process.exit(0);
}

process.on('SIGINT', destroyAllSubprocesses);
process.on('SIGTERM', destroyAllSubprocesses);
