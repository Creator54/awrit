---
name: awrit
description: Show images, web pages, and Android screens to the user from a terminal agent session using the awrit CLI. Use when a visual preview would help and the user has opted in to awrit.
---
<!-- awrit-managed: skill v1 -->

# awrit visual previews

Use the `awrit` CLI to show visuals. Check what works before promising anything.

## Check first

- `awrit capabilities --json` reports what was *detected* in the current terminal. Detected is not verified; if a step fails, say so.
- `awrit context` (session start hook) prints guidance for the current session. Trust it over this file.

## Commands

Current:

- `awrit capabilities [--json]`
- `awrit capture [TARGET] [--comment TEXT] [--region X,Y,W,H] --json` saves an immutable PNG and returns a `marker`; put it on its own line (Claude with awrit-chat renders it inline). Capture again after acting. For a device, use `awrit device screenshot NAME --out FILE`.
- `awrit overlay [TARGET] --json` opens the live view over the chat; the user presses Escape to return. `awrit overlay close` / `awrit overlay status`. Live devices open with `awrit device view NAME`.
- `awrit show TARGET [--mode split|tab] [--json]` opens a Kitty split or tab without taking focus. Needs Kitty remote control; the user must have enabled it. Never enable it yourself and never edit Kitty config.
- `awrit show TARGET --text "Notes" --mode companion [--columns 45:55] [--layout text-left|media-left]` renders notes beside an image, video, or framed web page in one Awrit window. `awrit device view NAME` opens a live Android screen. Narrow viewports stack vertically; sites may refuse framing.
- When the user has loaded `plugins/awrit-chat` with `claude --plugin-dir PATH`, a standalone `![awrit:caption](/absolute/path.png)` marker renders a static PNG beside reply text in the native terminal transcript. This requires the mod; the discovery hook alone does not enable it. PNGs must be regular files, at most 2 MiB, without sensitive paths or traversal. Live video/audio in chat is unsupported.

Other commands (check installed help and reported capability limitations):

- `awrit snapshot TARGET --out FILE.png` writes a static PNG. Use it when no preview pane is available and report the file path.
- `awrit inline IMAGE` draws in the terminal only when the session owns the TTY. Agent TUIs that capture or redraw output cannot display inline graphics, so do not use it from them and do not try to write to the terminal device directly.

## Rules

- A successful show receipt reports launched, not page-ready; verify visible content before claiming it was shown.
- Inline requires AWRIT_TERMINAL_OWNER=shell in an owned plain shell; never set it to bypass a harness-owned TUI. In that shell only, `awrit inline IMAGE --text "Notes" --columns 40:40` renders text beside a static image.
- Ask before opening new panes or tabs if the user did not request a preview.
- This setup was installed by the user via `awrit setup agents --claude`; remove with `--uninstall`.
