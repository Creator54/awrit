// Build-time only. Runtime distributions must be supplied explicitly, never fetched on launch.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyNodeRuntime } from './nodeRuntime';

const [destination, nodeDistribution, electronDistribution] = process.argv.slice(2);
if (!destination || !nodeDistribution || !electronDistribution) {
  throw new Error('Usage: bun packaging/build.ts OUTPUT NODE_DISTRIBUTION ELECTRON_DISTRIBUTION');
}
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Supported build hosts: Linux/macOS x64 or arm64');
}
const root = resolve(import.meta.dir, '..');
const output = resolve(destination);
if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
const node = resolve(nodeDistribution);
const electron = resolve(electronDistribution);
if (!existsSync(join(node, 'bin/node'))) throw new Error('Node distribution must contain bin/node');
const electronExe = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
if (!existsSync(join(electron, electronExe))) throw new Error(`Electron distribution must contain ${electronExe}`);
const nodeIdentity: { version: string; platform: string; arch: string } = JSON.parse(execFileSync(join(node, 'bin/node'), ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { encoding: 'utf8' }));
// Read the version file: running Electron needs a display and sandbox setup.
const versionFile = join(electron, 'version');
const electronVersion = `v${readFileSync(versionFile, 'utf8').trim().replace(/^v/, '')}`;
const expectedElectron = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies.electron;
const nodeParts = nodeIdentity.version.replace(/^v/, '').split('.').map(Number);
if (nodeParts[0] < 22 || (nodeParts[0] === 22 && nodeParts[1] < 12)) throw new Error('Private Node must be >=22.12.0');
if (nodeIdentity.platform !== process.platform || nodeIdentity.arch !== process.arch) throw new Error('Node target does not match build host');
if (electronVersion !== `v${expectedElectron}`) throw new Error(`Electron version mismatch: ${electronVersion}, expected ${expectedElectron}`);
const app = join(output, 'lib/awrit');
mkdirSync(join(output, 'bin'), { recursive: true });
mkdirSync(join(app, 'runtime'), { recursive: true });
copyNodeRuntime(node, join(app, 'runtime/node'));
cpSync(electron, join(app, 'runtime/electron'), { recursive: true, verbatimSymlinks: true });
cpSync(join(root, 'packaging/awrit'), join(output, 'bin/awrit'));
chmodSync(join(output, 'bin/awrit'), 0o755);
for (const name of ['config.js', 'package.json', 'skills', 'kittens', 'plugins', '.claude-plugin', 'containers']) {
  cpSync(join(root, name), join(app, name), { recursive: true });
}
// Keep packages external so their own relative asset and native-loader paths survive.
const copied = new Set<string>();
mkdirSync(join(output, 'LICENSES'), { recursive: true });
cpSync(join(root, 'LICENSE.txt'), join(output, 'LICENSES/awrit.txt'));
function copyDependency(name: string, from: string) {
  if (name.startsWith('@types/')) return; // Published type dependencies have no runtime entry.
  const require = createRequire(join(from, 'package.json'));
  const entry = require.resolve(name);
  let directory = dirname(entry);
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package root: ${name}`);
    directory = parent;
  }
  directory = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name) throw new Error(`Unexpected package root for ${name}: ${directory}`);
  const target = join(app, 'node_modules', name);
  if (copied.has(name)) {
    const prior = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    if (prior.version !== manifest.version) throw new Error(`Conflicting runtime versions: ${name}`);
    return;
  }
  copied.add(name);
  if (name === 'awrit-native-rs') {
    mkdirSync(target, { recursive: true });
    const binding = `awrit-native-rs.${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}.node`;
    for (const file of ['index.js', 'package.json', binding]) cpSync(join(directory, file), join(target, file));
  } else {
    cpSync(directory, target, { recursive: true, dereference: true });
  }
  for (const file of readdirSync(directory).filter(file => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(file))) {
    cpSync(join(directory, file), join(output, 'LICENSES', `${name.replaceAll('/', '_')}-${file}`), { recursive: true });
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) copyDependency(dependency, directory);
}
for (const name of ['awrit-native-rs', '@toon-format/toon', 'electron-chrome-extensions', 'electron-chrome-web-store']) copyDependency(name, root);
const entries = ['browserOwner/main.ts', 'terminal/main.ts', 'remote/androidOwner.ts', 'remote/pickerMain.ts', 'preload.js', 'content-preload.js'];
async function build(entrypoints: string[], outdir: string, naming?: string) {
  const result = await Bun.build({
    entrypoints: entrypoints.map(p => join(root, 'src', p)), root: join(root, 'src'),
    outdir, naming, target: 'node', format: 'cjs', packages: 'external',
    define: { __dirname: '(process.env.AWRIT_APP_ROOT + "/src")' },
  });
  if (!result.success) throw new AggregateError(result.logs, 'Standalone bundle failed');
}
await build(entries, join(app, 'dist'));
for (const [entry, name] of [['presentation/main.ts', 'presentation-cli.js'], ['presentation/captureMain.ts', 'captureMain.js'], ['adb/androidMain.ts', 'android-cli.js']]) {
  await build([entry], join(app, 'dist'), name);
}
// Vite is build-time only; do not invoke the development launcher in the artifact.
mkdirSync(join(root, 'dist'), { recursive: true });
if (!existsSync(join(root, 'dist/kitty.css'))) {
  writeFileSync(join(root, 'dist/kitty.css'), '');
}
const vite = Bun.spawn(['node', join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(root, 'src/runner/vite.config.ts')], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (await vite.exited !== 0) throw new Error('Toolbar build failed');
cpSync(join(root, 'dist/toolbar'), join(app, 'dist/toolbar'), { recursive: true });
writeFileSync(join(app, 'build.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: nodeIdentity.version, electron: electronVersion, lockSha256: createHash('sha256').update(readFileSync(join(root, 'bun.lock'))).digest('hex') }, null, 2));
console.log(`Built private artifact: ${output}`);
