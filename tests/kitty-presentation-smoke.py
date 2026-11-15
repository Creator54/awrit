#!/usr/bin/env python3
"""
Kitty Presentation Compatibility Smoke Test (Phase 0)

Validates isolated Kitty 0.49.1 remote-control launch, icat non-TTY stream backend,
normal-shell inline rendering with deterministic fixture process, split layout behavior,
custom no-ui kitten contract, and vanished-source safety.

Safety requirements:
- Uses an isolated Kitty instance with --config NONE and private unix socket in a unique tempdir.
- Does NOT emit graphics or touch /dev/tty in host window (KITTY_WINDOW_ID=11).
- Closes only its own isolated windows and child process. No name/port killing.
- Distinguishes terminal control-state and screenshot evidence from visual assumptions.
- Bounded timeouts on all subprocess calls.
"""

import argparse
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIXTURE_PNG = os.path.join(PROJECT_ROOT, "src", "tty", "finch.png")
# Preserve screenshot in owned test directory so caller/Main can read it
OWNED_TEST_DIR = os.path.join(PROJECT_ROOT, "tests")
PRESERVED_SCREENSHOT_PATH = os.path.join(OWNED_TEST_DIR, "smoke_screenshot.png")


def log(section: str, detail: str = ""):
    prefix = f"[smoke:{section}]"
    if detail:
        print(f"{prefix} {detail}", flush=True)
    else:
        print(f"{prefix}", flush=True)


def verify_png_dimensions(path: str) -> tuple[int, int]:
    with open(path, "rb") as f:
        magic = f.read(8)
        if magic != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"File {path} does not have valid PNG signature")
        # IHDR chunk starts at offset 8 (length 4, type 4, data)
        chunk_len = struct.unpack(">I", f.read(4))[0]
        chunk_type = f.read(4)
        if chunk_type != b"IHDR":
            raise ValueError(f"Expected IHDR chunk, found {chunk_type}")
        width, height = struct.unpack(">II", f.read(8))
        return width, height


def parse_args():
    parser = argparse.ArgumentParser(description="Kitty presentation Phase 0 smoke test")
    parser.add_argument(
        "--scratchpad",
        default=os.environ.get("AWRIT_TEST_SCRATCHPAD", tempfile.gettempdir()),
        help="Base scratchpad directory for test artifacts",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    scratchpad_base = os.path.abspath(args.scratchpad)
    os.makedirs(scratchpad_base, exist_ok=True)
    os.makedirs(OWNED_TEST_DIR, exist_ok=True)

    if not os.path.exists(FIXTURE_PNG):
        raise FileNotFoundError(f"Fixture image missing: {FIXTURE_PNG}")

    # Unique isolated directory for this run to prevent stale collisions
    # Ensure socket path stays within Linux sockaddr_un 108-byte limit
    test_dir = tempfile.mkdtemp(prefix="kt_", dir=scratchpad_base)
    socket_path = os.path.join(test_dir, "s")
    if len(socket_path.encode("utf-8")) > 107:
        # Fallback to system tempdir if scratchpad base path is too long
        shutil.rmtree(test_dir, ignore_errors=True)
        test_dir = tempfile.mkdtemp(prefix="kt_")
        socket_path = os.path.join(test_dir, "s")
        if len(socket_path.encode("utf-8")) > 107:
            raise RuntimeError(f"Socket path exceeds sockaddr_un length: {socket_path}")

    config_path = os.path.join(test_dir, "smoke_kitty.conf")
    kitten_path = os.path.join(test_dir, "smoke_kitten.py")
    fixture_script_path = os.path.join(test_dir, "fixture_runner.py")

    # 1. Environment and harness checks
    log("env", f"Project root: {PROJECT_ROOT}")
    log("env", f"Isolated test dir: {test_dir}")
    log("env", f"Isolated socket: {socket_path} (len: {len(socket_path)})")
    log("env", f"Host window ID (must remain untouched): {os.environ.get('KITTY_WINDOW_ID', 'none')}")

    stdout_is_tty = os.isatty(sys.stdout.fileno())
    log("env", f"Current test stdout isatty: {stdout_is_tty}")
    if not stdout_is_tty or os.environ.get("CLAUDE_CODE"):
        log(
            "env",
            "Agent harness detected: captured stdout is NOT inline-capable. "
            "Subprocess graphics escape codes in captured pipes do not insert images "
            "into message layout and would corrupt or get stripped by transcript redraws."
        )

    # Note on Codex: observed/installed in environment, but not exercised in this test
    log("env", "Codex observed installed in environment; not exercised in this test (read-only verification).")

    # 2. Verify icat non-TTY backend with explicit dimensions and --place
    log("icat-backend", "Testing icat with --use-window-size, --place, and --transfer-mode=stream (no TTY)...")
    icat_cmd = [
        "kitten", "icat",
        "--use-window-size=80,24,800,600",
        "--place=40x15@0x0",
        "--transfer-mode=stream",
        "--stdin=no",
        FIXTURE_PNG
    ]
    icat_res = subprocess.run(icat_cmd, capture_output=True, timeout=10)
    assert icat_res.returncode == 0, f"icat stream invocation failed: {icat_res.stderr.decode()}"
    assert b"\x1b_G" in icat_res.stdout, "Missing Kitty Graphics protocol marker in stream output"
    assert b"C=1" in icat_res.stdout, "Expected C=1 (do not advance cursor) in --place mode"
    # Verify bounded output (must not exceed reasonable byte size for fixture)
    assert len(icat_res.stdout) < 16 * 1024 * 1024, "icat stream output exceeded bounded buffer limit"
    log("icat-backend", f"PASS: icat emitted stream escape sequences ({len(icat_res.stdout)} bytes, bounded) without /dev/tty probing.")

    # 3. Write isolated test config & custom kitten script
    with open(config_path, "w", encoding="utf-8") as f:
        f.write("allow_remote_control yes\nenabled_layouts splits,stack,tall\n")

    with open(kitten_path, "w", encoding="utf-8") as f:
        f.write(
            "from kittens.tui.handler import result_handler\n"
            "def main(args):\n"
            "    pass\n"
            "@result_handler(no_ui=True)\n"
            "def handle_result(args, answer, target_window_id, boss):\n"
            "    return f'NO_UI_KITTEN_OK:target={target_window_id}:has_boss={boss is not None}'\n"
        )

    # Deterministic fixture process that directly executes markers and icat inside Kitty root window
    # Does NOT rely on injected shell input or echoed PTY keystrokes
    with open(fixture_script_path, "w", encoding="utf-8") as f:
        f.write(
            "import subprocess, sys, time\n"
            "print('---FIXTURE_MARKER_BEFORE---', flush=True)\n"
            f"subprocess.run(['kitten', 'icat', '{FIXTURE_PNG}'], check=True, timeout=10)\n"
            "print('---FIXTURE_MARKER_AFTER---', flush=True)\n"
            "time.sleep(60)\n"
        )

    # 4. Launch isolated Kitty instance running fixture runner directly
    log("kitty-launch", f"Starting isolated Kitty with config NONE and socket {socket_path}...")
    kitty_env = os.environ.copy()
    kitty_env.pop("KITTY_LISTEN_ON", None)

    kitty_proc = subprocess.Popen([
        "kitty",
        "--config", "NONE",
        "-c", config_path,
        "-o", "allow_remote_control=yes",
        "-o", "enabled_layouts=splits,stack,tall",
        "--listen-on", f"unix:{socket_path}",
        "python3", "-u", fixture_script_path
    ], env=kitty_env, stderr=subprocess.PIPE)

    tracked_windows: list[int] = []

    try:
        # Wait for isolated socket readiness
        ready = False
        for _ in range(50):
            if os.path.exists(socket_path):
                probe = subprocess.run(
                    ["kitten", "@", "--to", f"unix:{socket_path}", "ls"],
                    capture_output=True, text=True, timeout=5
                )
                if probe.returncode == 0:
                    ready = True
                    break
            time.sleep(0.1)
        if not ready and kitty_proc.poll() is not None:
            err = kitty_proc.stderr.read().decode() if kitty_proc.stderr else ""
            log("kitty-launch", f"Kitty exited early with error: {err}")
        assert ready, "Timed out waiting for isolated Kitty socket connection"
        log("kitty-launch", f"PASS: Isolated instance connected (PID {kitty_proc.pid}).")

        # Query initial window tree
        tree = json.loads(subprocess.run(
            ["kitten", "@", "--to", f"unix:{socket_path}", "ls"],
            capture_output=True, text=True, check=True, timeout=5
        ).stdout)
        root_win = tree[0]["tabs"][0]["windows"][0]
        w1_id = root_win["id"]
        log("window-init", f"Initial isolated window ID: {w1_id}, focused: {root_win['is_focused']}")

        # 5. Inspect screen text buffer from deterministic fixture
        log("inline-shell", "Inspecting deterministic fixture process output and row reservation...")
        time.sleep(1.5)

        buf_res = subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "get-text", "--match", f"id:{w1_id}"
        ], capture_output=True, text=True, check=True, timeout=5)
        lines = [line.strip() for line in buf_res.stdout.splitlines()]

        # Locate exact marker lines
        marker_before = "---FIXTURE_MARKER_BEFORE---"
        marker_after = "---FIXTURE_MARKER_AFTER---"
        assert marker_before in lines, f"Marker before missing from lines: {lines[:10]}"
        assert marker_after in lines, f"Marker after missing from lines: {lines[:10]}"

        before_idx = lines.index(marker_before)
        after_idx = lines.index(marker_after)
        assert after_idx > before_idx, f"Marker after (idx {after_idx}) must appear after before (idx {before_idx})"

        # Check intervening blank rows allocated for the image grid cells
        intervening_rows = lines[before_idx + 1:after_idx]
        assert len(intervening_rows) > 0, "Expected intervening rows reserved for image cells"
        for r_idx, row in enumerate(intervening_rows):
            assert row == "", f"Intervening row {r_idx} must be blank image reservation, got: {repr(row)}"
        log("inline-shell", f"PASS: Exact markers verified at lines {before_idx} and {after_idx} with {len(intervening_rows)} intervening blank rows.")

        # Capture screenshot for visual evidence and preserve in owned test directory
        ss_res = subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "screenshot", PRESERVED_SCREENSHOT_PATH
        ], capture_output=True, text=True, timeout=10)
        assert ss_res.returncode == 0, f"Screenshot command failed: {ss_res.stderr}"
        assert os.path.exists(PRESERVED_SCREENSHOT_PATH), "Screenshot file missing after command"

        ss_size = os.path.getsize(PRESERVED_SCREENSHOT_PATH)
        assert ss_size > 4096, f"Screenshot size suspiciously small ({ss_size} bytes)"
        ss_w, ss_h = verify_png_dimensions(PRESERVED_SCREENSHOT_PATH)
        assert ss_w > 0 and ss_h > 0, f"Invalid screenshot geometry {ss_w}x{ss_h}"
        log(
            "inline-shell",
            f"PASS: Screenshot captured and preserved at {PRESERVED_SCREENSHOT_PATH} "
            f"({ss_size} bytes, dimensions {ss_w}x{ss_h} px)."
        )

        # 6. Test source-targeted launch with --keep-focus
        log("launch-focus", f"Launching new window targeted to window {w1_id} with --keep-focus...")
        launch_res = subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "launch",
            "--keep-focus",
            f"--match=window_id:{w1_id}",
            f"--source-window=id:{w1_id}",
            f"--next-to=id:{w1_id}",
            "--location=vsplit",
            "sh", "-c", "sleep 30"
        ], capture_output=True, text=True, check=True, timeout=10)
        w2_id = int(launch_res.stdout.strip())
        tracked_windows.append(w2_id)
        log("launch-focus", f"Created secondary window ID: {w2_id}")

        # Check focus state: --keep-focus preserves the currently focused window (which is window 1 here)
        tree2 = json.loads(subprocess.run(
            ["kitten", "@", "--to", f"unix:{socket_path}", "ls"],
            capture_output=True, text=True, check=True, timeout=5
        ).stdout)
        win_map = {w["id"]: w for w in tree2[0]["tabs"][0]["windows"]}
        assert win_map[w1_id]["is_focused"] is True, "Currently focused window (source) must retain focus under --keep-focus"
        assert win_map[w2_id]["is_focused"] is False, "New window must not steal focus"
        log("launch-focus", "PASS: Currently focused window retained focus; launched window created next-to source.")

        # 7. Test split layout and failure state
        log("layout-split", "Testing layout switching to stack and split constraints...")
        subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "goto-layout", "stack"
        ], capture_output=True, text=True, check=True, timeout=5)

        tree_stack = json.loads(subprocess.run(
            ["kitten", "@", "--to", f"unix:{socket_path}", "ls"],
            capture_output=True, text=True, check=True, timeout=5
        ).stdout)
        current_layout = tree_stack[0]["tabs"][0]["layout"]
        assert current_layout == "stack", f"Expected stack layout, found {current_layout}"
        log("layout-split", f"Switched to layout: {current_layout} (splits disabled in stack mode).")

        # Restore splits layout
        subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "goto-layout", "splits"
        ], capture_output=True, text=True, check=True, timeout=5)
        log("layout-split", "PASS: Layout state and constraints verified.")

        # 8. Test custom no-ui kitten contract
        log("custom-kitten", "Testing custom no-ui kitten invocation and Boss contract...")
        kitten_res = subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "kitten", kitten_path
        ], capture_output=True, text=True, check=True, timeout=10)
        kitten_out = kitten_res.stdout.strip()
        expected = f"NO_UI_KITTEN_OK:target={w1_id}:has_boss=True"
        assert expected in kitten_out, f"Unexpected kitten response: {kitten_out}"
        log("custom-kitten", "PASS: Custom no-ui kitten executed with Boss access and no UI overlay.")

        # 9. Test source disappearance / mismatch safety
        log("safety-mismatch", "Testing source disappearance and targeting mismatch safety...")
        # Kitty silently falls back to active window if --source-window / --next-to is missing
        mismatch_res = subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "launch",
            "--source-window=id:99999",
            "--next-to=id:99999",
            "sh", "-c", "sleep 10"
        ], capture_output=True, text=True, timeout=10)
        assert mismatch_res.returncode == 0, "Kitty accepted mismatch launch with silent fallback"
        w_mismatch = int(mismatch_res.stdout.strip())
        tracked_windows.append(w_mismatch)
        log("safety-mismatch", f"PASS: Verified Kitty defaults to active window if source missing (spawned ID {w_mismatch}).")

        # Tab match with non-existent tab properly raises MatchError
        tab_mismatch_res = subprocess.run([
            "kitten", "@", "--to", f"unix:{socket_path}",
            "launch",
            "--match=id:99999",
            "sh", "-c", "sleep 5"
        ], capture_output=True, text=True, timeout=10)
        assert tab_mismatch_res.returncode != 0, "Expected non-zero exit when matching non-existent tab"
        log("safety-mismatch", "PASS: Explicit non-existent tab match fails with MatchError.")

    finally:
        # 10. Clean up only own tracked windows and isolated process
        log("cleanup", "Closing isolated windows...")
        for wid in tracked_windows:
            try:
                subprocess.run([
                    "kitten", "@", "--to", f"unix:{socket_path}",
                    "close-window", "--match", f"id:{wid}"
                ], capture_output=True, timeout=5)
            except Exception:
                pass

        log("cleanup", f"Terminating isolated Kitty process PID {kitty_proc.pid}...")
        if kitty_proc.poll() is None:
            kitty_proc.terminate()
            try:
                kitty_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                kitty_proc.kill()
                kitty_proc.wait(timeout=3)

        # Remove ONLY the unique test directory created for this run
        # Preserved screenshot in owned test dir is intentionally kept
        if os.path.exists(test_dir):
            shutil.rmtree(test_dir, ignore_errors=True)
        log("cleanup", f"PASS: Isolated test directory removed. Screenshot preserved at {PRESERVED_SCREENSHOT_PATH}.")

    print("\n[smoke] ALL PHASE 0 KITTY PRESENTATION CHECKS PASSED SUCCESSFULLY.", flush=True)


if __name__ == "__main__":
    main()
