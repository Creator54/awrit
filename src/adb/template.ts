import { type AndroidKeyConfig, DEFAULT_ANDROID_KEYS, DEFAULT_LEADER_KEY } from '../designKey';
import {
  type CompanionConfig,
  companionLayoutCss,
  parseCompanionConfig,
  renderCompanionText,
} from '../presentation/companion';

export function getAdbHtml(
  deviceWidth: number,
  deviceHeight: number,
  deviceName = 'Android',
  companion?: CompanionConfig,
  overlay = false,
  android: AndroidKeyConfig = { leader: DEFAULT_LEADER_KEY, keys: DEFAULT_ANDROID_KEYS },
): string {
  if (companion) companion = parseCompanionConfig(JSON.stringify(companion));
  const androidConfig = JSON.stringify(android).replaceAll('<', '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Awrit ADB: ${deviceName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
[hidden] { display: none !important; }
:root {
    --ui-bg: #151719;
    --ui-surface: #202326;
    --ui-raised: #292d30;
    --ui-line: #ffffff14;
    --ui-line-strong: #ffffff30;
    --ui-text: #e2e3e4;
    --ui-muted: #9da3a9;
    --ui-accent: #a6bacd;
    --space-1: 4px;
    --space-2: 8px;
    --control-size: 44px;
    --control-radius: 8px;
    --panel-radius: 12px;
}
html, body {
    width: 100%;
    height: 100%;
    background: #000;
    color: var(--ui-text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
}
.app-container {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
}
.toolbar {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    right: calc(var(--space-2) + var(--control-size) + var(--space-1));
    max-height: calc(100% - 2 * var(--space-2));
    display: flex;
    flex-wrap: wrap;
    align-content: start;
    align-items: center;
    justify-content: safe center;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--ui-surface);
    border: 1px solid var(--ui-line);
    border-radius: var(--panel-radius);
    overflow-x: auto;
    z-index: 10;
}
#controls-hotzone {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    width: var(--control-size);
    height: var(--control-size);
    display: flex;
    z-index: 10;
    pointer-events: none;
}
#controls-toggle { opacity: 0; pointer-events: auto; transition: opacity 0.15s; }
#controls-toggle:hover,
#controls-toggle:focus-visible,
.app-container:has(#android-controls:not([hidden])) #controls-toggle { opacity: 1; }
button {
    flex: 0 0 var(--control-size);
    width: var(--control-size);
    min-height: var(--control-size);
    padding: 0;
    border-radius: var(--control-radius);
    border: 1px solid var(--ui-line-strong);
    background: var(--ui-bg);
    color: var(--ui-text);
    cursor: pointer;
    font-weight: 500;
    white-space: nowrap;
    transition: background 0.1s, transform 0.05s;
}
button:hover { background: var(--ui-raised); }
button:active { background: var(--ui-raised); border-color: var(--ui-accent); transform: scale(0.96); }
button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
button svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.control-tip {
    position: fixed;
    z-index: 30;
    width: max-content;
    max-width: calc(100vw - 8px);
    overflow-wrap: anywhere;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--ui-line-strong);
    border-radius: var(--control-radius);
    background: var(--ui-surface);
    color: var(--ui-text);
    font-size: 12px;
    pointer-events: none;
}
.viewport-area {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #000;
}
#screen {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
    touch-action: none;
}
.fps-pill {
    align-self: center;
    margin: var(--space-1) 0;
    background: var(--ui-bg);
    border: 1px solid var(--ui-line);
    padding: var(--space-1) 12px;
    border-radius: var(--panel-radius);
    font-size: 12px;
    color: var(--ui-muted);
    font-family: monospace;
    pointer-events: none;
}
${companion ? companionLayoutCss(companion) + '\n.app-container.media-pane {width:auto;position:relative;user-select:none;} .text-pane {user-select:text;} .text-pane:focus {outline:2px solid #a1a1aa;outline-offset:-2px;}' : ''}
</style>
</head>
<body>
${companion ? `<div class="companion-container">${renderCompanionText(companion).replace('<div class="text-pane">', '<div class="text-pane" tabindex="0" aria-label="Device notes">')}` : ''}
<div class="app-container${companion ? ' media-pane' : ''}">
    <div id="controls-hotzone">
        <button id="controls-toggle" aria-label="Android controls (Alt+C)" title="Android controls (Alt+C)" aria-expanded="false" aria-controls="android-controls"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></svg></button>
    </div>
    <div class="toolbar" id="android-controls" hidden>
        <button data-key="KEYCODE_BACK" aria-label="Back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
        <button data-key="KEYCODE_HOME" aria-label="Home (Alt+Home)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7M5 9v12h14V9"/></svg></button>
        <button data-key="KEYCODE_APP_SWITCH" aria-label="Recents"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 20h10a2 2 0 0 0 2-2V8"/></svg></button>
        <button data-key="KEYCODE_POWER" aria-label="Power"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/></svg></button>
        <button data-key="KEYCODE_VOLUME_UP" aria-label="Volume up"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Zm4 7h6m-3-3v6"/></svg></button>
        <button data-key="KEYCODE_VOLUME_DOWN" aria-label="Volume down"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Zm4 7h6"/></svg></button>
        <button id="btn-rotate" aria-label="Rotate screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg></button>
        <button id="btn-screenshot" aria-label="Save screenshot"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
    </div>
    <div class="control-tip" id="control-tip" hidden></div>
    <div class="viewport-area" id="wrap">
        <img id="screen" src="/stream" alt="Phone Display" draggable="false" tabindex="-1">
    </div>
    <div class="fps-pill" id="hud">Live</div>
</div>

${companion ? '</div>' : ''}
<script>
const img = document.getElementById('screen');
const hud = document.getElementById('hud');
let inputWarningUntil = 0;
function showInputWarning(message) {
    inputWarningUntil = Date.now() + 5000;
    hud.textContent = message;
}
const controlTip = document.getElementById('control-tip');
const controls = document.getElementById('android-controls');
const controlsToggle = document.getElementById('controls-toggle');
function setControlsVisible(visible) {
    controls.hidden = !visible;
    controlsToggle.setAttribute('aria-expanded', String(visible));
    controlTip.hidden = true;
    (visible ? controls.querySelector('button') : img).focus();
    if (typeof window !== 'undefined' && window.awrit && typeof window.awrit.setAdbControlsVisible === 'function') {
        window.awrit.setAdbControlsVisible(visible);
    }
}
controlsToggle.onclick = () => setControlsVisible(controls.hidden);
let curW = ${deviceWidth};
let curH = ${deviceHeight};
const deviceName = ${JSON.stringify(deviceName).replaceAll('<', '\\u003c')};
const ANDROID = ${androidConfig};
// Long enough to press the action letter after the leader, matching the browser.
const LEADER_TIMEOUT_MS = 1500;
const LEADER_ACTIONS = {};
for (const [action, key] of Object.entries(ANDROID.keys)) LEADER_ACTIONS[String(key).toLowerCase()] = action;
let leaderPending = false;
let leaderTimer = null;

function endLeader() {
    leaderPending = false;
    if (leaderTimer !== null) {
        clearTimeout(leaderTimer);
        leaderTimer = null;
    }
}

// A key that types text (Space, a letter) would eat typed characters in phone
// fields, so it only starts leader mode with Ctrl, Alt or Meta.
function isLeader(e) {
    const binding = ANDROID.leader || '';
    if (!binding.startsWith('<')) return false;
    const parts = binding.slice(1, -1).split('-');
    const last = (parts.pop() || '').toLowerCase();
    const mods = new Set(parts.map((part) => part.toUpperCase()));
    const scored = mods.has('C') || mods.has('A') || mods.has('M');
    if (!scored && (last === 'space' || last.length === 1)) return false;
    if (e.ctrlKey !== mods.has('C') || e.altKey !== mods.has('A')) return false;
    if (e.metaKey !== mods.has('M') || e.shiftKey !== mods.has('S')) return false;
    return last === 'space' ? e.key === ' ' : e.key.toLowerCase() === last;
}

function runAndroidAction(action) {
    if (action === 'controls') setControlsVisible(controls.hidden);
    else if (action === 'back') sendKey('KEYCODE_BACK');
    else if (action === 'home') sendKey('KEYCODE_HOME');
    else if (action === 'rotate') rotateScreen();
    else if (action === 'screenshot') saveScreenshot();
}

function rotateScreen() {
    hud.textContent = 'Rotating...';
    postControl('/rotate', {});
}

function saveScreenshot() {
    hud.textContent = 'Saving screenshot...';
    fetch('/screenshot?t=' + Date.now())
        .then(response => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.blob();
        })
        .then(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'screenshot-' + Date.now() + '.jpg';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Let the browser consume the download URL before releasing its blob.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            hud.textContent = 'Screenshot download started';
        })
        .catch(() => { hud.textContent = 'Screenshot failed'; });
}

function showControlTip(btn) {
    const rect = btn.getBoundingClientRect();
    controlTip.textContent = btn.getAttribute('aria-label');
    controlTip.hidden = false;
    const { offsetWidth: width, offsetHeight: height } = controlTip;
    const gap = 4;
    const left = rect.left + (rect.width - width) / 2;
    const below = rect.bottom + gap;
    const top = below + height <= window.innerHeight - gap ? below : rect.top - height - gap;
    controlTip.style.left = Math.max(gap, Math.min(left, window.innerWidth - width - gap)) + 'px';
    controlTip.style.top = Math.max(gap, Math.min(top, window.innerHeight - height - gap)) + 'px';
}
function hideControlTip() { controlTip.hidden = true; }
window.addEventListener('resize', hideControlTip);
window.addEventListener('scroll', hideControlTip, true);
document.querySelectorAll('#android-controls button').forEach(btn => {
    const showTip = () => showControlTip(btn);
    btn.addEventListener('mouseenter', showTip);
    btn.addEventListener('mouseleave', hideControlTip);
    btn.addEventListener('focus', showTip);
    btn.addEventListener('blur', hideControlTip);
});

// Navigation buttons
document.querySelectorAll('button[data-key]').forEach(btn => {
    btn.onclick = (e) => {
        e.preventDefault();
        sendKey(btn.dataset.key);
    };
});

// Rotate button
const rotateBtn = document.getElementById('btn-rotate');
if (rotateBtn) {
    rotateBtn.onclick = (e) => {
        e.preventDefault();
        rotateScreen();
    };
}

// Screenshot button
const screenshotBtn = document.getElementById('btn-screenshot');
if (screenshotBtn) {
    screenshotBtn.onclick = (e) => {
        e.preventDefault();
        saveScreenshot();
    };
}

// Non-printable key mapping
const SPECIAL_KEYS = {
    'ArrowUp': 'KEYCODE_DPAD_UP',
    'ArrowDown': 'KEYCODE_DPAD_DOWN',
    'ArrowLeft': 'KEYCODE_DPAD_LEFT',
    'ArrowRight': 'KEYCODE_DPAD_RIGHT',
    'Enter': 'KEYCODE_ENTER',
    ${overlay ? '' : "'Escape': 'KEYCODE_BACK',\n"}    'Backspace': 'KEYCODE_DEL',
    'Delete': 'KEYCODE_FORWARD_DEL',
    'Tab': 'KEYCODE_TAB',
    'Home': 'KEYCODE_MOVE_HOME',
    'End': 'KEYCODE_MOVE_END',
    'PageUp': 'KEYCODE_PAGE_UP',
    'PageDown': 'KEYCODE_PAGE_DOWN'
};

// Alt shortcuts for navigation
const ALT_KEYS = {
    'home': 'KEYCODE_HOME',
    'b': 'KEYCODE_BACK',
    'r': 'KEYCODE_APP_SWITCH',
    'p': 'KEYCODE_POWER'
};

// Android Keycode mappings for Ctrl combinations
const CTRL_ANDROID_CODES = {
    'a': 29,  // KEYCODE_A (Select All)
    'x': 52,  // KEYCODE_X (Cut)
    'z': 54,  // KEYCODE_Z (Undo)
    'y': 53,  // KEYCODE_Y (Redo)
    'f': 34   // KEYCODE_F (Find)
};

const KEYCODE_CTRL_LEFT = 113;

document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    ${companion ? "if (e.target && typeof e.target.closest === 'function' && e.target.closest('.text-pane')) return;\n" : ''}if (e.getModifierState?.('AltGraph')) {
        if (e.key.length === 1) {
            e.preventDefault();
            endLeader();
            sendText(e.key);
        }
        return;
    }
    if (leaderPending) {
        // Repeats and bare modifier presses are not an answer to the leader.
        if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
        e.preventDefault();
        const action = LEADER_ACTIONS[e.key.toLowerCase()];
        endLeader();
        if (action) runAndroidAction(action);
        else hud.textContent = 'Leader cancelled';
        return;
    }
    if (isLeader(e)) {
        e.preventDefault();
        if (e.repeat) return;
        leaderPending = true;
        hud.textContent = 'Leader...';
        leaderTimer = setTimeout(() => {
            leaderPending = false;
            leaderTimer = null;
            hud.textContent = 'Leader timed out';
        }, LEADER_TIMEOUT_MS);
        return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        if (e.repeat) return;
        setControlsVisible(controls.hidden);
        return;
    }
    if (e.key === 'Escape' && controls && !controls.hidden) {
        e.preventDefault();
        setControlsVisible(false);
        return;
    }
    if (e.target.closest?.('#android-controls, #controls-toggle')) {
        return;
    }
    // Buttons handle Enter/Space themselves
    if (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;

    // Ctrl+A/X/Z/Y/F edit on the phone; Ctrl+Shift+C copies (plain Ctrl+C quits Awrit).
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
        const char = e.key.toLowerCase();
        const code = e.shiftKey ? (char === 'c' ? 31 : undefined) : CTRL_ANDROID_CODES[char];
        if (code) {
            e.preventDefault();
            hud.textContent = 'Ctrl+' + char.toUpperCase();
            postControl('/key', { keycodes: [KEYCODE_CTRL_LEFT, code] });
            return;
        }
        // Let other Ctrl keys (like Ctrl+R, Ctrl+W, Ctrl+Q) pass to awrit
        return;
    }

    if (e.metaKey) return;

    if (e.altKey) {
        const altKey = ALT_KEYS[e.key.toLowerCase()];
        if (altKey) {
            e.preventDefault();
            sendKey(altKey);
            return;
        }
    }

    if (e.altKey) return;
    const selectionCodes = { ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, Tab: 61 };
    if (e.shiftKey && selectionCodes[e.key]) {
        e.preventDefault();
        postControl('/key', { keycodes: [59, selectionCodes[e.key]] });
        return;
    }

    // Special control / navigation keys
    const special = SPECIAL_KEYS[e.key];
    if (special) {
        e.preventDefault();
        sendKey(special);
        return;
    }

    // Normal typing keys (letters, numbers, symbols, space)
    if (e.key.length === 1) {
        e.preventDefault();
        sendText(e.key);
    }
});

document.addEventListener('paste', (e) => {
    ${companion ? "if (e.target && typeof e.target.closest === 'function' && e.target.closest('.text-pane')) return;\n" : ''}const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) {
        e.preventDefault();
        sendText(text);
    }
});

function sendText(text) {
    if (/[^\\x20-\\x7e]/.test(text)) {
        showInputWarning('Only printable ASCII text is supported');
        return;
    }
    hud.textContent = 'Typing';
    const paste = text.length > 256 ? { failed: false } : null;
    for (let offset = 0; offset < text.length; offset += 256) {
        postControl('/text', { text: text.slice(offset, offset + 256) }, Infinity, paste);
    }
}

function sendKey(keycode) {
    hud.textContent = keycode.replace('KEYCODE_', '');
    postControl('/key', { keycode });
}

let controlQueue = Promise.resolve();
// Controls run one at a time in the order they were asked for; gesture moves are the only
// exception, pipelined by the gesture transport below while a finger is down.
function enqueueControl(task) {
    const result = controlQueue.then(task).catch(() => {
        hud.textContent = 'Control failed';
        return false;
    });
    controlQueue = result.then(() => {});
    return result;
}

let queuedText = null;
function postControl(path, body, deadline = Infinity, paste = null) {
    if (path === '/text' && deadline === Infinity && queuedText && queuedText.paste === paste && queuedText.body.text.length + body.text.length <= 256) {
        queuedText.body.text += body.text;
        return queuedText.result;
    }
    const textBatch = path === '/text' ? { body: { ...body }, result: null, paste } : null;
    queuedText = deadline === Infinity ? textBatch : null;
    const result = enqueueControl(async () => {
        if (queuedText === textBatch) queuedText = null;
        if (Date.now() > deadline || paste?.failed) return false;
        let res;
        try {
            res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(textBatch ? textBatch.body : body),
            signal: AbortSignal.timeout(8000)
        });
            if (!res.ok) throw new Error('ADB command failed');
        } catch (error) {
            if (paste) {
                paste.failed = true;
                showInputWarning('Typing stopped: some text may already be entered');
                return false;
            }
            throw error;
        }
        return true;
    });
    if (textBatch) textBatch.result = result;
    return result;
}

// Precision Coordinate Mapping (Accounting for object-fit: contain letterbox/pillarbox)
function getDeviceCoords(e) {
    const rect = img.getBoundingClientRect();
    const elemW = rect.width;
    const elemH = rect.height;
    const natW = img.naturalWidth || curW;
    const natH = img.naturalHeight || curH;

    const elemRatio = elemW / elemH;
    const natRatio = natW / natH;

    let renderW = elemW;
    let renderH = elemH;
    let offsetX = 0;
    let offsetY = 0;

    if (elemRatio > natRatio) {
        renderW = elemH * natRatio;
        offsetX = (elemW - renderW) / 2;
    } else {
        renderH = elemW / natRatio;
        offsetY = (elemH - renderH) / 2;
    }

    const pointer = e.touches?.[0] || e.changedTouches?.[0] || e;
    const clientX = pointer.clientX;
    const clientY = pointer.clientY;

    const imgX = clientX - rect.left - offsetX;
    const imgY = clientY - rect.top - offsetY;

    if (imgX < 0 || imgX > renderW || imgY < 0 || imgY > renderH) {
        return null;
    }

    const devX = Math.round((imgX / renderW) * curW);
    const devY = Math.round((imgY / renderH) * curH);

    return {
        x: Math.max(0, Math.min(curW - 1, devX)),
        y: Math.max(0, Math.min(curH - 1, devY))
    };
}

// Touch & Drag Handling (clicks, taps, and live drags)
let isDown = false;
// Counts presses, so a reply for an older press cannot drive the current one.
let pressSeq = 0;
let startPos = null;
let lastTapTime = 0;
let lastTapPos = null;

// Gesture transport shared by drags and wheel scrolling. The page session plus an increasing
// epoch identify one finger, and every event carries a newer sequence, so the server can drop
// a move or lift that arrives late instead of letting it press or jump the current finger.
const GESTURE_SESSION = Math.random().toString(36).slice(2, 10);
// Pointer events arrive faster than the screen refreshes; ~16ms moves are enough.
const GESTURE_MOVE_MS = 16;
// Move acks cost a device round trip; a few may be in flight before newer points wait.
const GESTURE_MAX_INFLIGHT = 3;

let gestureSeq = 0;
let gestureEpoch = 0;
// { epoch, point, pending, sent, sealed }: one finger at a time, whatever drives it.
let gesture = null;

// Keep a point on the visible screen after a resize.
function screenClamp(pt) {
    return {
        x: Math.max(0, Math.min(curW - 1, Math.round(pt.x))),
        y: Math.max(0, Math.min(curH - 1, Math.round(pt.y)))
    };
}

function gestureBody(current, phase, point) {
    return {
        phase,
        id: GESTURE_SESSION,
        epoch: current.epoch,
        seq: ++gestureSeq,
        x: point.x,
        y: point.y
    };
}

function sendGesture(current, phase, point) {
    const request = fetch('/gesture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gestureBody(current, phase, point)),
        signal: AbortSignal.timeout(8000)
    }).then(res => res.ok).catch(() => false);
    current.sent.push(request);
    request.then(() => {
        current.sent = current.sent.filter(entry => entry !== request);
    });
    return request;
}

function openGesture(point, kind) {
    const current = {
        epoch: ++gestureEpoch,
        point,
        pending: null,
        sent: [],
        sealed: false,
        open: false,
        // What opened the finger, so a page leaving lifts the hand it was closing.
        kind,
        liftQueued: false,
        unloadLifted: false
    };
    gesture = current;
    return postControl('/gesture', gestureBody(current, 'down', point)).then(ok => {
        current.open = ok;
        return ok;
    });
}

// A refused move means this finger cannot be trusted: end it, which lifts exactly once.
function failGesture(current) {
    if (current !== gesture || current.sealed) return;
    endDragGesture();
    endScrollGesture();
    // Still pressed: ignore the rest of this press instead of silently pressing again.
    dragFailed = isDown;
}

function flushGestureMove() {
    const current = gesture;
    if (!current || !current.open || current.sealed || current.pending === null) return;
    if (current.sent.length >= GESTURE_MAX_INFLIGHT) return;
    const point = current.pending;
    current.pending = null;
    gestureMove(point);
}

function gestureMove(point) {
    const current = gesture;
    // A move is admitted only once the press itself was acknowledged by the device.
    if (!current || !current.open || current.sealed) return Promise.resolve(false);
    current.point = point;
    return sendGesture(current, 'move', point).then(ok => {
        if (!ok) failGesture(current);
        else if (current === gesture) flushGestureMove();
        return ok;
    });
}

// The lift marks the gesture sealed now, so no move can extend it. It reaches the device after
// every move already sent, and any later press queues behind it instead of being lifted by it.
// A leaving page cancels queued work, so the lift goes out at once and outlives the page.
function unloadLift(current, point) {
    current.unloadLifted = true;
    current.liftQueued = false;
    fetch('/gesture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gestureBody(current, 'up', point)),
        keepalive: true
    }).catch(() => {});
}

function sealGesture(point, unloading) {
    const current = gesture;
    if (!current) return Promise.resolve(true);
    if (!current.sealed) {
        current.sealed = true;
        current.pending = null;
    } else if (!unloading || current.unloadLifted) {
        // Already sealed: only a page that is leaving still needs to send the lift itself.
        return Promise.resolve(true);
    }
    if (unloading) {
        unloadLift(current, point);
        return Promise.resolve(true);
    }
    // Number the lift now, so a later keepalive lift from this same gesture is newer and the
    // server drops this queued one instead of writing a second lift.
    const body = gestureBody(current, 'up', point);
    current.liftQueued = true;
    return enqueueControl(async () => {
        await Promise.all(current.sent);
        current.liftQueued = false;
        const res = await fetch('/gesture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error('ADB command failed');
        return true;
    });
}

// A press that travels past the tap threshold becomes a live gesture, so a drag (Recents,
// sliders, edge swipes) follows the pointer instead of one synthetic swipe at release.
let dragHeld = false;      // this press owns a device finger
let dragPoint = null;      // latest pointer position while held
let dragTimer = null;      // coalesces pointer moves into one pipeline slot
let dragFailed = false;    // the down request failed, so this press stays quiet until release
let dragKeepalive = null;  // re-sends the held point so the server's idle lift spares a still finger
const DRAG_KEEPALIVE_MS = 400;

function tapThreshold() {
    // Gesture thresholds are CSS pixels, not the phone's physical resolution.
    return 15 * Math.max(curW / img.clientWidth, curH / img.clientHeight);
}

function endDragGesture(unloading) {
    if (dragTimer !== null) {
        clearTimeout(dragTimer);
        dragTimer = null;
    }
    if (dragKeepalive !== null) {
        clearInterval(dragKeepalive);
        dragKeepalive = null;
    }
    const point = dragPoint || startPos;
    if (dragHeld) {
        dragHeld = false;
        sealGesture(screenClamp(point), unloading);
        return;
    }
    // The release already queued this drag's lift behind in-flight moves; a page leaving now
    // must send it itself instead of losing it with the queue.
    if (unloading && point && gesture && gesture.kind === 'drag' && gesture.liftQueued) {
        sealGesture(screenClamp(point), true);
    }
}

function scheduleDragMove() {
    if (dragTimer !== null || !dragHeld) return;
    dragTimer = setTimeout(() => {
        dragTimer = null;
        const current = gesture;
        if (!dragHeld || !current) return;
        // Only the newest pointer position is kept; older ones were already superseded.
        current.pending = screenClamp(dragPoint);
        flushGestureMove();
    }, GESTURE_MOVE_MS);
}

function onPointerDown(e) {
    if (typeof e.button === 'number' && e.button !== 0) return;
    const pt = getDeviceCoords(e);
    if (!pt) return;
    // One finger at a time: a wheel scroll that is still down lifts first.
    if (scrollActive) endScrollGesture();
    pressSeq++;
    isDown = true;
    startPos = pt;
    dragPoint = pt;
    dragHeld = false;
    dragFailed = false;
}

function onPointerMove(e) {
    if (!isDown || !startPos) return;
    const pt = getDeviceCoords(e);
    if (!pt) return;
    dragPoint = pt;
    if (dragHeld) {
        scheduleDragMove();
        return;
    }
    if (dragFailed) return;
    if (Math.hypot(pt.x - startPos.x, pt.y - startPos.y) <= tapThreshold()) return;
    // The device finger starts at the press point, not where the threshold was crossed.
    dragHeld = true;
    const press = pressSeq;
    openGesture(startPos, 'drag').then(ok => {
        // A press from an earlier drag may settle after this press started.
        if (press !== pressSeq) return;
        if (!ok) {
            // No finger to move or lift; stay quiet until the press ends.
            dragHeld = false;
            dragFailed = true;
            return;
        }
        if (!dragHeld) return;
        hud.textContent = 'Drag';
        // A late ack from an earlier press must not leave its timer running.
        if (dragKeepalive !== null) clearInterval(dragKeepalive);
        dragKeepalive = setInterval(() => {
            if (dragHeld && dragTimer === null) scheduleDragMove();
        }, DRAG_KEEPALIVE_MS);
        scheduleDragMove();
    });
}

function onPointerUp(e) {
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (!isDown || !startPos) return;
    isDown = false;
    const start = startPos;
    startPos = null;
    const endPos = getDeviceCoords(e) || dragPoint || start;
    dragPoint = endPos;
    const wasDrag = dragHeld || dragFailed;
    endDragGesture();
    if (wasDrag || Math.hypot(endPos.x - start.x, endPos.y - start.y) >= tapThreshold()) {
        // A drag lifts itself; movement without a drag (the down request failed) sends nothing.
        lastTapTime = 0;
        lastTapPos = null;
        return;
    }
    const now = Date.now();
    const deviceScale = Math.max(curW / img.clientWidth, curH / img.clientHeight);
    const isDoubleTap = lastTapPos && (now - lastTapTime < 350) && Math.hypot(start.x - lastTapPos.x, start.y - lastTapPos.y) < 30 * deviceScale;
    if (isDoubleTap) {
        lastTapTime = 0;
        lastTapPos = null;
        hud.textContent = 'Wake';
        postControl('/wake', {});
        postControl('/tap', { x: start.x, y: start.y });
    } else {
        lastTapTime = now;
        lastTapPos = start;
        hud.textContent = \`Tap \${start.x},\${start.y}\`;
        postControl('/tap', { x: start.x, y: start.y });
    }
}

// ponytail: terminal ticks cannot provide continuous finger tracking; live moves can.
// Keep these local to the viewer: hardware/terminal gain varies between machines.
const SCROLL_GAIN = 0.55;
const SCROLL_END_MS = 120;
let scrollActive = false;
let scrollVertical = true;
let scrollPoint = { x: curW / 2, y: curH / 2 };
let scrollPending = 0;
let scrollBusy = false;
let scrollTimer = null;
let scrollEndTimer = null;

// Keep the pressed finger inside the screen margins, leaving room to travel both ways.
function scrollClamp(pt) {
    const edgeX = Math.round(curW * 0.08);
    const edgeY = Math.round(curH * 0.1);
    return {
        x: Math.max(edgeX, Math.min(curW - 1 - edgeX, Math.round(pt.x))),
        y: Math.max(edgeY, Math.min(curH - 1 - edgeY, Math.round(pt.y)))
    };
}

function endScrollGesture(unloading) {
    if (scrollEndTimer !== null) {
        clearTimeout(scrollEndTimer);
        scrollEndTimer = null;
    }
    // A resize may have shrunk the screen while the finger was down; clamp the lift onto it.
    const point = screenClamp(scrollPoint);
    if (!scrollActive) {
        // A flick whose lift is still queued is lost with the queue when the page leaves.
        if (unloading && gesture && gesture.kind === 'scroll' && gesture.liftQueued) {
            scrollPoint = point;
            sealGesture(point, true);
        }
        return;
    }
    scrollActive = false;
    scrollPending = 0;
    scrollPoint = point;
    sealGesture(point, unloading);
}

function scheduleScrollMove() {
    if (scrollTimer !== null || scrollBusy) return;
    scrollTimer = setTimeout(flushScrollMove, GESTURE_MOVE_MS);
}

function flushScrollMove() {
    scrollTimer = null;
    if (!scrollActive || scrollBusy) return;
    const delta = Math.round(scrollPending);
    if (delta === 0) return;
    scrollPending -= delta;
    const next = scrollClamp({
        x: scrollPoint.x - (scrollVertical ? 0 : delta),
        y: scrollPoint.y - (scrollVertical ? delta : 0)
    });
    const stuck = next.x === scrollPoint.x && next.y === scrollPoint.y;
    scrollPoint = next;
    scrollBusy = true;
    const closing = gesture;
    const step = stuck
        // The finger reached a margin: lift and flick again from the far side, like a repeated
        // finger flick, so a sustained scroll keeps moving instead of stalling there.
        ? sealGesture(next).then(ok => {
              if (!ok || !scrollActive || gesture !== closing) return false;
              const edgeX = Math.round(curW * 0.08);
              const edgeY = Math.round(curH * 0.1);
              const restart = scrollClamp({
                  x: scrollVertical ? next.x : (delta > 0 ? curW - 1 - edgeX : edgeX),
                  y: scrollVertical ? (delta > 0 ? curH - 1 - edgeY : edgeY) : next.y
              });
              const restarted = openGesture(restart, 'scroll');
              const owner = gesture;
              return restarted.then(ok => {
                  // A reply for a finger that already ended must not move this one.
                  if (gesture !== owner) return false;
                  if (!ok) {
                      // The finger is up and cannot be restarted; stop pretending it is held.
                      scrollActive = false;
                      scrollPending = 0;
                      return false;
                  }
                  scrollPoint = restart;
                  return true;
              });
          })
        : gestureMove(next);
    step.then(success => {
        scrollBusy = false;
        if (!success) scrollPending = 0;
        else if (scrollActive && Math.round(scrollPending) !== 0) scheduleScrollMove();
    });
}

function executeScroll(pt, dy, dx) {
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const delta = vertical ? dy : dx;
    if (!Number.isFinite(delta) || delta === 0) return;
    // One finger at a time: a held drag lifts before the wheel takes over.
    if (dragHeld) endDragGesture();
    if (scrollActive && vertical !== scrollVertical) endScrollGesture();
    if (!scrollActive) {
        scrollActive = true;
        scrollVertical = vertical;
        scrollPoint = scrollClamp(pt);
        scrollPending = 0;
        const start = scrollPoint;
        scrollBusy = true;
        const started = openGesture(start, 'scroll');
        const owner = gesture;
        started.then(ok => {
            // A reply for a finger that already ended must not drive this one.
            if (gesture !== owner) return;
            scrollBusy = false;
            if (ok) {
                // The queued travel is already older than one frame; send it now.
                flushScrollMove();
                return;
            }
            // No finger is down, so the queued travel is dropped instead of posted as moves.
            if (scrollActive && scrollPoint === start) {
                scrollActive = false;
                scrollPending = 0;
            }
        });
    }
    const scale = Math.max(curW / img.clientWidth, curH / img.clientHeight);
    const limit = (vertical ? curH : curW) * 0.5;
    scrollPending = Math.max(-limit, Math.min(limit, scrollPending + delta * scale * SCROLL_GAIN));
    if (scrollEndTimer !== null) clearTimeout(scrollEndTimer);
    scrollEndTimer = setTimeout(() => {
        scrollEndTimer = null;
        endScrollGesture();
    }, SCROLL_END_MS);
    scheduleScrollMove();
}

window.addEventListener('wheel', (e) => {
    if (e.target.closest?.('#android-controls, #controls-toggle')) return;
    const pt = getDeviceCoords(e);
    if (!pt) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? img.clientHeight : 1;
    executeScroll(pt, e.deltaY * unit, e.deltaX * unit);
}, { passive: false });

// Never leave the phone's finger down when the pointer, page or window goes away.
function endGestures(unloading) {
    endDragGesture(unloading);
    endScrollGesture(unloading);
    // Invalidate the press as well as lifting its device finger: a late move or
    // release after cancellation must not reopen the gesture or synthesize a tap.
    pressSeq++;
    isDown = false;
    startPos = null;
    dragPoint = null;
    dragFailed = false;
    twoTouchStart = null;
    twoTouchPoint = null;
    lastTapTime = 0;
    lastTapPos = null;
}
img.addEventListener('pointerleave', (e) => {
    // Touch pointers leave on release before touchend, which owns finishing the tap.
    if (e.pointerType !== 'touch') endGestures();
});
img.addEventListener('pointercancel', () => endGestures());
window.addEventListener('blur', () => { endLeader(); endGestures(); });
window.addEventListener('pagehide', () => { endLeader(); endGestures(true); });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { endLeader(); endGestures(); }
});

// Touchscreen 2-finger gesture support
let twoTouchStart = null;
let twoTouchPoint = null;

function onTouchStart(e) {
    // We handle the touch ourselves; suppress its duplicate compatibility mouse events.
    e.preventDefault();
    if (e.touches.length > 2) {
        endGestures();
        return;
    }
    if (e.touches.length === 2) {
        endGestures();
        const p1 = getDeviceCoords({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        const p2 = getDeviceCoords({ clientX: e.touches[1].clientX, clientY: e.touches[1].clientY });
        if (p1 && p2) {
            twoTouchStart = {
                x: Math.round((p1.x + p2.x) / 2),
                y: Math.round((p1.y + p2.y) / 2)
            };
            twoTouchPoint = twoTouchStart;
        }
        return;
    }
    twoTouchStart = null;
    onPointerDown(e);
}

function onTouchEnd(e) {
    if (twoTouchStart) {
        if (e.touches.length === 0 && e.changedTouches.length > 0) {
            const p = twoTouchPoint;
            if (p) {
                const dy = twoTouchStart.y - p.y;
                const dx = twoTouchStart.x - p.x;
                if (Math.abs(dy) > 20 || Math.abs(dx) > 20) {
                    executeScroll(twoTouchStart, dy, dx);
                }
            }
            twoTouchStart = null;
            twoTouchPoint = null;
        }
        return;
    }
    onPointerUp(e);
}

function onTouchMove(e) {
    if (twoTouchStart) {
        if (e.touches.length === 2) {
            const p1 = getDeviceCoords(e.touches[0]);
            const p2 = getDeviceCoords(e.touches[1]);
            if (p1 && p2) {
                twoTouchPoint = { x: Math.round((p1.x + p2.x) / 2), y: Math.round((p1.y + p2.y) / 2) };
            }
        }
        return;
    }
    if (e.touches.length !== 1) return;
    onPointerMove(e);
}

img.addEventListener('mousedown', onPointerDown);
window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mouseup', onPointerUp);
img.addEventListener('touchstart', onTouchStart, { passive: false });
window.addEventListener('touchmove', onTouchMove, { passive: false });
window.addEventListener('touchend', onTouchEnd);
window.addEventListener('touchcancel', () => endGestures());

// Immediate & Periodic status check for HUD
async function updateStatus() {
    try {
        const res = await fetch('/status');
        if (res.ok) {
            const data = await res.json();
            if (data.w && data.h) {
                curW = data.w;
                curH = data.h;
            }
            const state = data.hasFrame ? (data.fps > 0 ? data.fps + ' FPS' : 'Live · idle') : 'Starting stream…';
            const text = data.connected === false ? 'Offline' : \`\${state} (\${curW}x\${curH}) [\${deviceName}]\`;
            if (data.connected === false || Date.now() >= inputWarningUntil) {
                if (hud.textContent !== text) hud.textContent = text;
            }
        } else if (hud.textContent !== 'Offline') {
            hud.textContent = 'Offline';
        }
    } catch (e) {
        if (hud.textContent !== 'Offline') hud.textContent = 'Offline';
    }
}
updateStatus();
setInterval(updateStatus, 1000);

// Auto-reconnect stream on error
img.onerror = () => {
    setTimeout(() => {
        img.src = '/stream?t=' + Date.now();
    }, 1000);
};
</script>
</body>
</html>`;
}
