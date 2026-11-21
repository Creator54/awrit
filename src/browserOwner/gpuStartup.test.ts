import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the startup policy without launching or changing the installed owner.
const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const startup = main.slice(main.indexOf('// Linux Chromium'), main.indexOf('// Remote owners'));

function features(backend: string, env: NodeJS.ProcessEnv, initial = 'SmoothScrolling', platform = 'linux') {
  const switches = new Map([['ozone-platform', backend], ['enable-features', initial]]);
  vm.runInNewContext(startup, {
    process: { platform, env },
    app: { commandLine: { getSwitchValue: (key: string) => switches.get(key) ?? '', appendSwitch: switches.set.bind(switches) } },
  });
  return switches.get('enable-features');
}

const wayland = { WAYLAND_DISPLAY: 'wayland-test' };

test('does not force Vulkan on Wayland where it breaks offscreen video', () => {
  expect(features('wayland', {})).toBe('SmoothScrolling');
  expect(features('', wayland)).toBe('SmoothScrolling');
  expect(features('auto', wayland)).toBe('SmoothScrolling');
  expect(features('wayland', {}, 'SmoothScrolling,Vulkan')).toBe('SmoothScrolling,Vulkan');
});

test('preserves Vulkan defaults on X11 and headless Linux, and leaves macOS unchanged', () => {
  expect(features('x11', wayland)).toBe('SmoothScrolling,Vulkan');
  expect(features('headless', wayland)).toBe('SmoothScrolling,Vulkan');
  expect(features('', {})).toBe('SmoothScrolling,Vulkan');
  expect(features('', {}, 'SmoothScrolling', 'darwin')).toBe('SmoothScrolling');
});
