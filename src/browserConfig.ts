import { buildBrowserBindings } from './browserBindings';
import { loadKeyBindings } from './keybindings';
import { loadSessionConfig } from './session';
import { createNewWindow, cycleFocus } from './windows';

export function loadBrowserConfig(config: typeof import('../config.js')) {
  if (config.keybindings) {
    loadKeyBindings({
      keybindings: buildBrowserBindings(config, {
        createNewWindow,
        cycleFocus,
      }),
    });
  }
  if (config.profile !== undefined) {
    loadSessionConfig({ profile: config.profile });
  }
}
