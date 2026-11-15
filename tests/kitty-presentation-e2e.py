#!/usr/bin/env python3
"""Isolated real-Kitty E2E for Awrit presentation: inline image, show --mode split,
resize, and the custom kitten. Usage:
  tests/kitty-presentation-e2e.py --launcher /path/to/awrit --evidence-dir DIR
Isolation: own kitty (--config NONE), abstract unix socket (no path-length limit),
temp HOME/XDG, local file fixtures only. Cleans up only its own windows/PIDs."""
import argparse, base64, hashlib, http.client, json, os, shutil, signal, socket, struct
import subprocess, sys, tempfile, time, zlib
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FINCH = os.path.join(ROOT, "src", "tty", "finch.png")
KITTEN = os.path.join(ROOT, "kittens", "awrit.py")
BANDS = [(400, "ff0000"), (600, "0000ff"), (800, "ffff00")]  # innerWidth < n; else 00ff00
HTML = ("<!doctype html><title>e2e</title><style>html,body{margin:0;height:100%%}"
        "body{background:#00ff00}%s</style><body>")


def band(w):
    return next((c for lim, c in BANDS if w < lim), "00ff00")


def log(msg): print(f"[e2e] {msg}", flush=True)


def run(cmd, timeout=15, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)


def png_pixels(path):
    """Decode 8-bit non-interlaced RGB/RGBA PNG -> (w, h, list of row bytes as RGB)."""
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w = 8, b"", 0
    while pos < len(d):
        n, t = struct.unpack(">I4s", d[pos:pos + 8]); body = d[pos + 8:pos + 8 + n]
        if t == b"IHDR": w, h, depth, ct, _, _, il = struct.unpack(">IIBBBBB", body)
        elif t == b"IDAT": idat += body
        pos += 12 + n
    assert depth == 8 and ct in (2, 6) and il == 0, f"unsupported PNG ct={ct} depth={depth}"
    bpp, stride = (3 if ct == 2 else 4), w * (3 if ct == 2 else 4)
    raw, prev, rows, p = zlib.decompress(idat), bytearray(stride), [], 0
    for _ in range(h):
        f, cur = raw[p], bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for i in range(stride):
            a = cur[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: cur[i] = (cur[i] + a) & 255
            elif f == 2: cur[i] = (cur[i] + b) & 255
            elif f == 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(cur)); prev = cur
    return w, h, bpp, rows


def color_hist(path):
    w, h, bpp, rows = png_pixels(path)
    c = Counter()
    for r in rows[::4]:  # every 4th row is plenty for dominance
        c.update(zip(*[iter(r)] * bpp))
    tot = sum(c.values())
    return w, h, {"%02x%02x%02x" % k[:3]: v / tot for k, v in c.most_common(8)}


class Cdp:
    """Minimal stdlib CDP client: Runtime.evaluate on the first file:// page."""
    def __init__(self, port): self.port = port
    def pages(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        c.request("GET", "/json/list"); return json.loads(c.getresponse().read())
    def eval(self, expr):
        pg = next(p for p in self.pages() if p.get("type") == "page" and p["url"].startswith("file:"))
        path = pg["webSocketDebuggerUrl"].split(str(self.port), 1)[1]
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf: buf += s.recv(4096)
        buf = buf.split(b"\r\n\r\n", 1)[1]
        msg = json.dumps({"id": 1, "method": "Runtime.evaluate",
                          "params": {"expression": expr, "returnByValue": True}}).encode()
        mask = os.urandom(4); n = len(msg)
        hdr = bytes([0x81, 0x80 | (n if n < 126 else 126)]) + (struct.pack(">H", n) if n >= 126 else b"")
        s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))
        def need(k):
            nonlocal buf
            while len(buf) < k: buf += s.recv(65536)
        while True:
            need(2); ln = buf[1] & 127; off = 2
            if ln == 126: need(4); ln = struct.unpack(">H", buf[2:4])[0]; off = 4
            elif ln == 127: need(10); ln = struct.unpack(">Q", buf[2:10])[0]; off = 10
            need(off + ln); data, buf = buf[off:off + ln], buf[off + ln:]
            try: r = json.loads(data)
            except ValueError: continue
            if r.get("id") == 1: s.close(); return r["result"]["result"]["value"]


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def clean_env(extra=None):
    drop = ("CLAUDE", "AI_AGENT", "CODEX", "KITTY_", "AWRIT_")
    e = {k: v for k, v in os.environ.items() if not k.startswith(drop)}
    e.update(extra or {}); return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--launcher", required=True)
    ap.add_argument("--evidence-dir", required=True)
    ap.add_argument("--same-pane", action="store_true")
    a = ap.parse_args()
    launcher = os.path.realpath(a.launcher); assert os.access(launcher, os.X_OK), launcher
    ev = os.path.abspath(a.evidence_dir); os.makedirs(ev, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="awe2e_")
    sock = f"unix:@awrit-e2e-{os.getpid()}-{os.urandom(3).hex()}"
    home = os.path.join(tmp, "home"); os.makedirs(home)
    port = free_port()
    # The packaged wrapper force-exports AWRIT_LAUNCHER, so env injection is ignored. Test copies drop
    # that one line: plain.sh honors the env; cdp.sh also adds an ephemeral CDP port to the browser.
    src_txt = [l for l in open(launcher).read().splitlines(True) if "export AWRIT_LAUNCHER=" not in l]
    plain, wrapper = os.path.join(tmp, "plain.sh"), os.path.join(tmp, "cdp.sh")
    open(plain, "w").write("".join(src_txt))
    open(wrapper, "w").write("".join(src_txt).replace('--high-dpi-support=1 "$@"', f'--high-dpi-support=1 --debug-port={port} "$@"'))
    for f in (plain, wrapper): os.chmod(f, 0o755)
    page = os.path.join(tmp, "page.html")
    open(page, "w").write(HTML % "".join(f"@media(max-width:{l - 1}px){{body{{background:#{c}}}}}"
                                         for l, c in reversed(BANDS)))
    go = os.path.join(tmp, "go")
    fx = os.path.join(tmp, "fixture.sh")
    open(fx, "w").write(f'''#!/bin/sh
echo ---BEFORE---
while [ ! -e "{go}" ]; do sleep 0.2; done
AWRIT_TERMINAL_OWNER=shell timeout 60 "{launcher}" inline "{FINCH}" {('--text="SAME-PANE NOTES\nExplanation beside the image.\nSecond paragraph stays left.\nMedia occupies the right column.\nBoth start on the same row." --columns=30:30 --height=10' if a.same_pane else '--width=30 --height=10')}
echo ---RC=$?---
echo ---AFTER---
sleep 600
''')
    os.chmod(fx, 0o755)
    base_env = clean_env({"HOME": home, "XDG_CONFIG_HOME": home + "/c", "XDG_CACHE_HOME": home + "/k",
                          "XDG_DATA_HOME": home + "/d", "AWRIT_LAUNCHER": plain})
    kitty = subprocess.Popen(
        ["kitty", "--config", "NONE", "-o", "allow_remote_control=yes", "-o", "enabled_layouts=splits",
         "-o", "remember_window_size=no", "-o", "initial_window_width=120c",
         "-o", "initial_window_height=36c", "--listen-on", sock, fx],
        env=base_env, stderr=subprocess.DEVNULL)
    rc = lambda *c, t=15: run(["kitten", "@", "--to", sock, *c], timeout=t)
    ls = lambda: json.loads(rc("ls").stdout)
    wins = lambda: {w["id"]: w for o in ls() for t in o["tabs"] for w in t["windows"]}
    def shot(name):
        p = os.path.join(ev, name); r = rc("screenshot", p)
        assert r.returncode == 0, r.stderr
        return p
    text = lambda wid: rc("get-text", "--match", f"id:{wid}").stdout
    def wait(pred, what, timeout=60):
        end = time.time() + timeout
        last_error = None
        while time.time() < end:
            try:
                v = pred()
                if v: return v
            except Exception as error:
                last_error = error
            time.sleep(0.4)
        detail = f"; last error: {last_error}" if last_error is not None else ""
        sys.exit(f"TIMEOUT waiting for {what}{detail}")
    own_pids, tracked = {kitty.pid}, []
    try:
        wait(lambda: rc("ls").returncode == 0, "isolated socket")
        src = next(iter(wins())); log(f"isolated source window {src}; socket {sock}; CDP port {port}")
        wait(lambda: "---BEFORE---" in text(src), "BEFORE marker")
        w0, h0, h_before = color_hist(shot("1-inline-before.png"))
        open(go, "w").close()
        wait(lambda: "---AFTER---" in text(src), "AFTER marker", 90)
        lines = [l.strip() for l in text(src).splitlines()]
        assert "---RC=0---" in lines, f"inline launcher failed: {lines[:12]}"
        b, af = lines.index("---BEFORE---"), lines.index("---RC=0---")
        gap = lines[b + 1:af]
        assert gap, "image rows not reserved"
        if a.same_pane:
            assert "SAME-PANE NOTES" in "\n".join(gap), gap
        else:
            assert all(x == "" for x in gap), f"image rows not reserved: {gap}"
        _, _, h_after = color_hist(shot("2-inline-after.png"))
        assert h_after != h_before and len(h_after) >= len(h_before), (h_before, h_after)
        log(f"PASS inline: {len(gap)} reserved rows between markers; colors before={list(h_before)[:3]} after={list(h_after)[:5]}")

        # show --mode split through the real launcher with exact isolated source/socket
        env = clean_env({"HOME": home, "XDG_CONFIG_HOME": home + "/c", "XDG_CACHE_HOME": home + "/k",
                         "XDG_DATA_HOME": home + "/d", "KITTY_LISTEN_ON": sock,
                         "KITTY_WINDOW_ID": str(src), "AWRIT_LAUNCHER": wrapper})
        r = run([plain, "show", page, "--mode", "split", "--json"], timeout=60, env=env)
        assert r.returncode == 0, f"show failed rc={r.returncode} {r.stdout} {r.stderr}"
        rec = json.loads(r.stdout); log(f"show receipt: {rec}")
        assert rec["mode"] == "split" and rec["source"] == src and rec["readiness"] == "launched"
        pv = rec["id"]; tracked.append(pv)
        w = wins(); assert w[src]["is_focused"] and not w[pv]["is_focused"], "chat focus not preserved"
        pw = w[pv]
        log("real ls window fields: " + ",".join(sorted(pw)))
        cdp = Cdp(port)
        def painted():
            win_w = cdp.eval("innerWidth")
            _, _, h = color_hist(shot("3-split-painted.png"))
            return (win_w, h) if h.get(band(win_w), 0) > 0.03 else None
        iw1, h1 = wait(painted, "viewer to paint fixture band", 90)
        cols1 = wins()[pv]["columns"]
        log(f"PASS paint: pane {cols1} cols, CDP innerWidth {iw1} -> band {band(iw1)} fraction {h1[band(iw1)]:.2f}")
        assert wins()[src]["is_focused"], "focus lost after paint"

        # resize: OS window first (may be ignored by tiling WMs), fall back to isolated pane resize
        rc("resize-os-window", "--width", "180", "--height", "50", "--unit", "cells")
        how = "resize-os-window"
        try: wait(lambda: wins()[pv]["columns"] != cols1, "OS resize", 6)
        except SystemExit:
            rc("resize-window", "--match", f"id:{pv}", "--axis=horizontal", "--increment=-25")
            how = "resize-window (WM ignored OS resize)"
        cols2 = wait(lambda: wins()[pv]["columns"] if wins()[pv]["columns"] != cols1 else 0, "pane resize", 10)
        def repainted():
            iw = cdp.eval("innerWidth")
            if iw == iw1: return None
            _, _, h = color_hist(shot("4-after-resize.png"))
            return (iw, h) if h.get(band(iw), 0) > 0.03 else None
        iw2, h2 = wait(repainted, "viewport change + repaint", 60)
        log(f"PASS resize via {how}: cols {cols1}->{cols2}, CDP innerWidth {iw1}->{iw2}, band {band(iw1)}->{band(iw2)}")
        pids = [p["pid"] for p in wins()[pv].get("foreground_processes", [])]; own_pids.update(pids)

        # custom kitten, no-ui, real runtime: must launch the same launcher on the same file URL
        before = set(wins())
        k = rc("kitten", "--match", f"id:{src}", KITTEN, "split", page)
        assert k.returncode == 0, f"kitten failed: {k.stderr}"
        new = wait(lambda: set(wins()) - before, "kitten-launched window"); tracked += list(new)
        nw = wins()[next(iter(new))]
        if "__show_error__" in nw["cmdline"][1]: sys.exit("kitten reported error: " + text(nw["id"]).strip())
        pc = [x for x in pw["cmdline"] if not x.startswith("--debug-port")]
        assert nw["cmdline"] == pc and nw["cmdline"][-1] == "file://" + page, (nw["cmdline"], pc)
        log(f"PASS kitten: new window {nw['id']} cmdline={nw['cmdline']}")
        assert wins()[src]["is_focused"]
        if a.same_pane:
            # Keep text + image inside one Awrit viewport, with host chat untouched.
            for wid in tracked:
                rc("close-window", "--match", f"id:{wid}")
            tracked.clear()
            r = run([plain, "show", FINCH, "--mode=companion", "--text=# Same pane\nNotes beside a real image.", "--json"], timeout=60, env=env)
            assert r.returncode == 0, (r.stdout, r.stderr)
            rec = json.loads(r.stdout); cv = rec["id"]; tracked.append(cv)
            assert rec["surface"] == "companion" and rec["mode"] == "tab", rec
            cdp = Cdp(port)
            def geometry():
                return cdp.eval("""(() => {
                  const t = document.querySelector('.text-pane'), m = document.querySelector('.media-pane'), i = document.querySelector('img');
                  if (!t || !m || !i || !i.complete || !i.naturalWidth) return null;
                  const a=t.getBoundingClientRect(),b=m.getBoundingClientRect();
                  return {text:t.textContent,x:a.x,y:a.y,right:a.right,mx:b.x,my:b.y,innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};
                })()""")
            g = wait(geometry, "same-pane image and text geometry")
            assert "Same pane" in g["text"] and not g["overflow"], g
            assert g["right"] <= g["mx"] + 1 and abs(g["y"]-g["my"]) < 1, g
            assert wins()[src]["is_focused"], "companion stole focus"
            shot("5-same-pane-image.png")
            log(f"PASS companion: actual image + notes side-by-side in window {cv}: {g}")
            # Narrow viewport must stack rather than hide/clobber media.
            # CSS container queries are optional; real browser emulation changes viewport.
            rc("goto-layout", "--match", f"window_id:{cv}", "splits")
            helper = rc("launch", "--match", f"window_id:{cv}", "--type=window", "--location=vsplit", "--keep-focus", "--", "sleep", "600")
            if helper.returncode == 0:
                hv = int(helper.stdout.strip()); tracked.append(hv)
                rc("resize-window", "--match", f"id:{cv}", "--axis=horizontal", "--increment=-40")
                narrow = wait(lambda: geometry() if geometry()["innerWidth"] < 600 else None, "narrow companion viewport", 20)
                assert not narrow["overflow"] and narrow["my"] > narrow["y"], narrow
                shot("6-same-pane-narrow.png")
                log(f"PASS companion responsive stack: {narrow}")
        log("ALL E2E CHECKS PASSED; evidence in " + ev)
    finally:
        try:
            shot("final-screen.png")
            open(os.path.join(ev, "windows.json"), "w").write(json.dumps([{k: w.get(k) for k in ("id", "cmdline", "foreground_processes", "columns", "lines")} for w in wins().values()], indent=2))
            for wid in tracked:
                open(os.path.join(ev, f"window-{wid}.txt"), "w").write(text(wid))
        except Exception as error:
            log(f"Could not capture final diagnostics: {error}")
        for directory in (os.path.join(home, "d"), os.path.join(home, ".local", "share")):
            viewer_log = os.path.join(directory, "awrit", "awrit.log")
            if os.path.isfile(viewer_log):
                shutil.copyfile(viewer_log, os.path.join(ev, "viewer.log"))
        for wid in tracked:
            run(["kitten", "@", "--to", sock, "close-window", "--match", f"id:{wid}"], timeout=5)
        for p in own_pids - {kitty.pid}:
            try: os.kill(p, signal.SIGTERM)
            except OSError: pass
        kitty.terminate()
        try: kitty.wait(5)
        except subprocess.TimeoutExpired: kitty.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
