import type { PresentationCommand } from './args';
import { HARNESSES } from './contextGuidance';

export function presentationHelp(command: PresentationCommand): string {
  const usage: Record<PresentationCommand, string> = {
    capabilities: 'awrit capabilities [--json]',
    context: 'awrit context [--claude] [--harness NAME] [--browsing useful|always|asked] [--json]',
    inline:
      'awrit inline IMAGE [--width CELLS] [--height CELLS] [--text TEXT --columns TEXT:MEDIA]',
    show: 'awrit show TARGET [--mode MODE] [--text TEXT --columns TEXT:MEDIA] [--json]\n  awrit show URL --host ALIAS [--remote-awrit PATH] [--forward PORT] [--session ID]',
    snapshot:
      'awrit snapshot TARGET --out FILE.png [--viewport WIDTHxHEIGHT] [--overwrite] [--json]',
    setup:
      'awrit setup [kitty | agents --claude | plugins] [--yes] [--dry-run] [--uninstall [--purge]] [--browsing useful|always|asked] [--json]',
    overlay:
      'awrit overlay [TARGET | close | status] [--json]\n  awrit overlay --text TEXT   replace the text beside an open video overlay',
    capture: 'awrit capture [TARGET] [--comment TEXT] [--region X,Y,W,H] [--json]',
    video: 'awrit video PATH [--mode overlay [--text TEXT]] [--json]',
  };

  const notes: Partial<Record<PresentationCommand, string>> = {
    capabilities: 'Shows what the terminal supports. It does not check that images render.\n',
    context: `NAME: ${HARNESSES.join(', ')}.\n`,
    inline:
      'Needs image support in both the terminal and the agent app.\nRuns only in a plain shell you own: AWRIT_TERMINAL_OWNER=shell awrit inline IMAGE.\nLayout with --text: --layout text-left|media-left (default: text-left).\n',
    show: 'MODE: auto, inline, split, tab, overlay, window or companion.\nAndroid devices: awrit device view NAME.\nInline sizing: --width CELLS, --height CELLS. With --text, use --columns instead of --width.\nLayout with --text: --layout text-left|media-left (default: text-left).\nVideo files (.mp4 .mov .m4v .webm) play in a Kitty overlay.\n--host runs the page on that ssh host and draws it here; it asks before installing a runtime there.\n--forward PORT reaches a service on this machine from that page; it asks first and only accepts an http(s) URL on localhost. On the remote host, localhost normally means that host.\nCtrl-D leaves the page running there for 10 minutes and prints how to come back with --session ID (a --forward page ends instead); Ctrl-C ends it.\n',
    capture:
      'Page readiness: --wait-ms MS (0–60000), --wait-selector CSS.\nExample: awrit capture https://example.com --wait-selector main --json\n',
    snapshot:
      'Page readiness: --wait-ms MS (0–60000), --wait-selector CSS.\nExample: awrit snapshot https://example.com --out page.png --wait-selector main\n',
    video: 'Prepares frames, or plays the video in a Kitty overlay.\n',
  };

  if (command === 'setup') {
    return `Usage: ${usage.setup}\n\nChoose agents, then when to show web pages. Adds Awrit instructions and, where needed, a plugin or feedback extension. Your existing instructions are kept outside the marked Awrit section.\n\nPreview: awrit setup --dry-run\nRemove:  awrit setup --uninstall\nAlso delete saved reviews, captures and logs: awrit setup --uninstall --purge\n`;
  }

  return `Usage: ${usage[command]}\n${notes[command] ? `\n${notes[command]}` : ''}`;
}
