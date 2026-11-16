#!/usr/bin/env python3
"""Isolated real-Kitty smoke test for chat-row video playback.

Validates that a video clip plays inside a real Claude Code chat row:
1. Dominant non-background terminal color changes over time across screenshots.
2. Overall terminal content bounds remain stable (not a video-only position check).
3. Separately reports verified vs unverified capabilities (pause, seek, scroll-away, macOS).

Usage:
  python3 -I tests/kitty-video-playback-smoke.py \\
      --launcher PATH_TO_awrit --plugin-dir plugins/awrit-chat --evidence-dir DIR
"""
import argparse
import importlib.util
import json
import re
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def load_e2e_helpers():
    spec = importlib.util.spec_from_file_location("presentation_e2e", ROOT / "tests" / "kitty-presentation-e2e.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.png_pixels, mod.color_hist


def generate_fixture(ffmpeg_bin: str, dest_path: Path) -> None:
    cmd = [
        ffmpeg_bin, "-y", "-f", "lavfi",
        "-i", "color=c=red:s=320x180:r=10:d=20,hue=H=2*PI*t",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(dest_path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg fixture generation failed: {res.stderr.strip()}")


def get_dominant_non_bg(color_hist_fn, image_path: Path):
    _, _, hist = color_hist_fn(str(image_path))
    if not hist:
        return None
    colors = sorted(hist.items(), key=lambda x: x[1], reverse=True)
    return next((c for c, _ in colors[1:] if c != colors[0][0]), None)


def find_content_bbox(png_pixels_fn, image_path: Path):
    w, h, bpp, rows = png_pixels_fn(str(image_path))
    bg = rows[0][:3]

    def diff(px):
        return sum(abs(a - b) for a, b in zip(px[:3], bg)) > 35

    y_matches = [y for y, r in enumerate(rows) if sum(1 for x in range(w) if diff(r[x * bpp:(x + 1) * bpp])) > max(20, w // 10)]
    if not y_matches:
        return None
    min_y, max_y = y_matches[0], y_matches[-1]
    x_matches = [x for x in range(w) if any(diff(rows[y][x * bpp:(x + 1) * bpp]) for y in y_matches[::4])]
    return (x_matches[0], min_y, x_matches[-1], max_y) if x_matches else None


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--launcher", required=True, help="Path to awrit launcher")
    p.add_argument("--plugin-dir", required=True, help="Path to plugin directory")
    p.add_argument("--evidence-dir", required=True, help="Evidence directory")
    p.add_argument("--command", default="/awrit-video", help="Slash command (default: /awrit-video)")
    p.add_argument("--pause-keys", default="", help="Keys to send for exploratory pause input (not an assertion)")
    p.add_argument("--columns", type=int, default=120, help="Isolated terminal width in cells")
    p.add_argument("--rows", type=int, default=36, help="Isolated terminal height in cells")
    p.add_argument("--isolated-home", action="store_true", help="use a throwaway HOME (Claude will ask to sign in, so only for already-authenticated CI setups)")
    p.add_argument("--timeout", type=int, default=45, help="Timeout in seconds")
    args = p.parse_args()
    if args.columns < 20 or args.rows < 10:
        p.error("viewport must be at least 20 columns by 10 rows")

    launcher = Path(args.launcher).resolve()
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        sys.exit(f"Error: launcher '{args.launcher}' does not exist or is not executable")
    plugin_dir = Path(args.plugin_dir).resolve()
    if not plugin_dir.is_dir():
        sys.exit(f"Error: plugin directory '{args.plugin_dir}' does not exist")

    missing = [name for name in ("kitty", "kitten", "claude") if not shutil.which(name)]
    if missing:
        sys.exit(f"Error: required binary '{missing[0]}' not found in PATH")
    kitty_bin, kitten_bin, claude_bin = shutil.which("kitty"), shutil.which("kitten"), shutil.which("claude")

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        print("SKIPPED: 'ffmpeg' not found in PATH; cannot generate video fixture")
        sys.exit(0)

    evidence_dir = Path(args.evidence_dir).resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    png_pixels_fn, color_hist_fn = load_e2e_helpers()

    # Isolated filesystem unix socket path (< 95 bytes for macOS/Linux sockaddr_un limit)
    # Use /tmp, not $TMPDIR: under nix-shell the socket under $TMPDIR vanished mid-run
    # (reproduced twice, cause not found), while /tmp passed.
    test_dir = Path(tempfile.mkdtemp(prefix="awv_", dir="/tmp"))
    sock_path = test_dir / "k.sock"
    if len(str(sock_path).encode("utf-8")) > 95:
        sys.exit(f"Error: unix socket path exceeds limit ({sock_path})")

    endpoint = f"unix:{sock_path}"
    home = test_dir / "home"
    home.mkdir(parents=True, exist_ok=True)

    clean_env = {
        k: v for k, v in os.environ.items()
        if not (k.startswith(("KITTY_", "CLAUDE", "AWRIT_")) or k in ("CODEX_THREAD_ID",))
    }
    clean_env.update({
        # Never redirect XDG_DATA_HOME: Claude relinks its own launcher there and would
        # leave a dangling ~/.local/bin/claude once the temp dir is removed.
        "AWRIT_LAUNCHER": str(launcher),
    })
    if args.isolated_home:
        clean_env.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / "c"), "XDG_CACHE_HOME": str(home / "k"), "XDG_DATA_HOME": str(home / "d")})

    fixture_clip = test_dir / "fixture.mp4"
    generate_fixture(ffmpeg_bin, fixture_clip)

    kitty_proc = subprocess.Popen(
        [
            kitty_bin, "--config", "NONE", "-o", "allow_remote_control=yes",
            "-o", "remember_window_size=no", "-o", f"initial_window_width={args.columns}c",
            "-o", f"initial_window_height={args.rows}c", "--listen-on", endpoint,
            claude_bin, "--plugin-dir", str(plugin_dir),
        ],
        env=clean_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    def rc(*cmd, timeout=10):
        res = subprocess.run([kitten_bin, "@", "--to", endpoint, *cmd], capture_output=True, text=True, timeout=timeout)
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip() or res.stdout.strip() or f"rc error {res.returncode}")
        return res.stdout

    def list_windows():
        out = rc("ls")
        return [w for o in json.loads(out) for t in o["tabs"] for w in t["windows"]]

    def wait(predicate, desc, timeout=30):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                val = predicate()
                if val:
                    return val
            except Exception as err:
                last = err
            time.sleep(0.3)
        raise RuntimeError(f"Timed out waiting for {desc} (last error: {last})")

    try:
        init_win = wait(lambda: next(iter(list_windows()), None), "isolated kitty window", 15)
        window_id = init_win["id"]

        # Tiling compositors ignore the requested size, so ask niri for it and report what we got.
        if shutil.which("niri") and os.environ.get("NIRI_SOCKET") and init_win["columns"] != args.columns:
            px_per_col = None
            try:
                cur = json.loads(subprocess.run(["niri", "msg", "--json", "focused-window"], capture_output=True, text=True, timeout=5).stdout)
                if cur.get("app_id") != "kitty":
                    raise RuntimeError("focused window is not kitty")
                px_per_col = cur["layout"]["window_size"][0] / init_win["columns"]
                subprocess.run(["niri", "msg", "action", "set-column-width", str(int(args.columns * px_per_col))], capture_output=True, timeout=5)
                time.sleep(1.5)
            except Exception as err:
                print(f"[INFO] Could not resize the window under niri: {err}")
        actual = next((w for w in list_windows() if w["id"] == window_id), init_win)
        print(f"[INFO] Requested {args.columns} columns, terminal reports {actual['columns']}x{actual['lines']}")

        def get_text():
            return rc("get-text", "--match", f"id:{window_id}")

        # Wait for Claude Code prompt in THIS window only
        # A sign-in screen is not a prompt: stop with a clear reason instead of a misleading result.
        def ready_or_login():
            text = get_text()
            if "Paste code here" in text or "oauth/authorize" in text or "Select login method" in text:
                return "login"
            return "ready" if "\u276f" in text else None

        state = wait(ready_or_login, "Claude prompt", timeout=args.timeout)
        if state == "login":
            sys.exit(
                "BLOCKED: the isolated Claude asks for sign-in, so nothing was tested. "
                "Run without --isolated-home so the session reuses your normal Claude login."
            )
        time.sleep(0.5)

        # Run playback command on THIS window id only
        rc("send-text", "--match", f"id:{window_id}", f"{args.command} {fixture_clip}")
        time.sleep(0.7)  # let argument suggestions settle before submitting
        rc("send-key", "--match", f"id:{window_id}", "enter")

        try:
            wait(
                lambda: any(k in get_text() for k in ("Video loaded", "awrit-video", "Pause", "▶", "❚❚")),
                "video playback UI", timeout=15,
            )
        except RuntimeError:
            time.sleep(1.0)

        # Capture at least 3 screenshots spaced apart while video plays
        shots = []
        for i in range(1, 4):
            shot_file = evidence_dir / f"screenshot-{i}.png"
            rc("screenshot", "--match", f"id:{window_id}", str(shot_file))
            shots.append(shot_file)
            time.sleep(0.8)

        if args.pause_keys:
            rc("send-text", "--match", f"id:{window_id}", args.pause_keys)
            time.sleep(0.5)
            pause_file = evidence_dir / "screenshot-pause.png"
            rc("screenshot", "--match", f"id:{window_id}", str(pause_file))
            print("Pause input sent; screenshot recorded, playback state not asserted")

        try:
            (evidence_dir / "terminal-text.txt").write_text(get_text())
        except Exception:
            pass

        # Click the real controls with SGR mouse events and read the card text back.
        def transport_row():
            for i, line in enumerate(get_text().split("\n")):
                if "\u2502" in line and re.search(r"\d:\d\d", line) and ("\u2501" in line or "\u2500" in line):
                    return i, line
            return None

        def elapsed(line):
            m = re.search(r"(\d+):(\d\d)", line)
            return int(m.group(1)) * 60 + int(m.group(2)) if m else None

        def click(col, row):
            for ev in ("M", "m"):
                rc("send-text", "--match", f"id:{window_id}", f"\x1b[<0;{col + 1};{row + 1}{ev}")
                time.sleep(0.05)

        pause_ok = seek_ok = None
        try:
            found = transport_row()
            if found:
                row, line = found
                glyph_col = line.find("\u275a\u275a")
                if glyph_col >= 0:
                    click(glyph_col, row)
                    time.sleep(1.0)
                    t1 = elapsed(transport_row()[1])
                    time.sleep(2.0)
                    after = transport_row()[1]
                    pause_ok = "\u25b6" in after and t1 is not None and elapsed(after) == t1
                    rc("screenshot", "--match", f"id:{window_id}", str(evidence_dir / "paused.png"))
                    (evidence_dir / "paused.txt").write_text(get_text())
                    # Seek: click near the start of the track, then expect elapsed to be earlier.
                    # Paused here, so nothing moves the playhead except our click.
                    track_start = after.find("\u25cf")
                    bar = [i for i, c in enumerate(after) if c in "\u2501\u2500\u25cf"]
                    if bar and track_start > bar[0] + 4:
                        before_t = elapsed(after)
                        click(bar[0] + 1, row)
                        time.sleep(1.0)
                        new_line = transport_row()[1]
                        new_head = new_line.find("\u25cf")
                        seek_ok = (
                            0 <= new_head < track_start
                            and elapsed(new_line) is not None
                            and elapsed(new_line) < before_t
                        )
                        rc("screenshot", "--match", f"id:{window_id}", str(evidence_dir / "seeked.png"))
                        (evidence_dir / "seeked.txt").write_text(get_text())
        except Exception as err:
            print(f"[INFO] Control interaction failed: {err}")

        # Assertion 1: dominant non-background color of video region differs
        dom_colors = [get_dominant_non_bg(color_hist_fn, s) for s in shots]
        valid_colors = [c for c in dom_colors if c is not None]
        color_pass = len(set(valid_colors)) >= 2

        # Overall content bounds only; this does not isolate the video rectangle.
        bboxes = [find_content_bbox(png_pixels_fn, s) for s in shots]
        b0, b1, b2 = bboxes
        pos_pass = (
            all(b is not None for b in bboxes)
            and abs(b0[0] - b1[0]) <= 8 and abs(b0[1] - b1[1]) <= 8
            and abs(b1[0] - b2[0]) <= 8 and abs(b1[1] - b2[1]) <= 8
            and (b0[2] - b0[0]) > 20 and (b0[3] - b0[1]) > 20
        )

        print("\n=== Playback Smoke Test Summary ===")
        print(f"[{'PASS' if color_pass else 'FAIL'}] Dominant non-background terminal color changed across frames: {dom_colors}")
        print(f"[{'PASS' if pos_pass else 'FAIL'}] Stable overall terminal content bounds across frames: {bboxes}")
        def report(label, ok):
            print(f"[{'NOT-VERIFIED' if ok is None else 'PASS' if ok else 'FAIL'}] {label}")

        report("Pause playback control (click stops the clock and shows play)", pause_ok)
        report("Seek control (click on the track moves the playhead back)", seek_ok)
        print("[NOT-VERIFIED] Terminal scroll-away buffer persistence")
        print(f"[INFO] Playback smoke platform: {platform.system()} (actual {actual['columns']}x{actual['lines']} cells)")
        print("[NOT-VERIFIED] Full macOS control/layout testing")

        controls_required = platform.system() == "Linux"
        controls_bad = (
            (pause_ok is not True or seek_ok is not True) if controls_required else (pause_ok is False or seek_ok is False)
        )
        if not (color_pass and pos_pass) or controls_bad:
            sys.exit(1)

    finally:
        if kitty_proc.poll() is None:
            kitty_proc.terminate()
            try:
                kitty_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                kitty_proc.kill()
                kitty_proc.wait()
        shutil.rmtree(test_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
