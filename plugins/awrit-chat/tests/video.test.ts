import type { FsStat, ProcessRunResult, UiBlitResult } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import {
  extractVideoPayload,
  fitCellDimensions,
  isSafePath,
  parseVideoReceipt,
  playheadSegment,
  segmentTargetFrame,
  trackSegmentWidths,
} from '../hooks/video';

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__awrit-chat__awrit_video': {
      path: string;
      caption?: string;
      text?: unknown;
      changes?: unknown;
      summary?: unknown;
      layout?: unknown;
      extra_bad_field?: number;
    };
  }
}

const VALID_RECEIPT = {
  id: 'vid-0123456789abcdef01234567',
  source: '/tmp/test-video.mp4',
  dir: '/appdata/video-previews/vid-0123456789abcdef01234567',
  poster: '/appdata/video-previews/vid-0123456789abcdef01234567/f00001.png',
  width: 1280,
  height: 720,
  count: 50,
  fps: 10,
  duration: 5.0,
};

test('isSafePath and parseVideoReceipt validation contracts', async () => {
  expect(isSafePath('/valid/path/file.mp4')).toBe(true);
  expect(isSafePath('-flag')).toBe(false);
  expect(isSafePath('relative/path')).toBe(false);
  expect(isSafePath('/path/with/\x00/control')).toBe(false);
  expect(isSafePath('/path/../escape')).toBe(false);
  expect(isSafePath('/.ssh/id_rsa')).toBe(false);
  expect(isSafePath('/proc/cpuinfo')).toBe(false);

  expect(parseVideoReceipt(VALID_RECEIPT)).toEqual(VALID_RECEIPT);
  expect(parseVideoReceipt({ ...VALID_RECEIPT, id: 'bad-id' })).toBeNull();
  expect(parseVideoReceipt({ ...VALID_RECEIPT, poster: '/other/path.png' })).toBeNull();
  expect(parseVideoReceipt({ ...VALID_RECEIPT, count: 0 })).toBeNull();
  expect(parseVideoReceipt({ ...VALID_RECEIPT, count: 601 })).toBeNull();
  expect(parseVideoReceipt({ ...VALID_RECEIPT, duration: 65 })).toBeNull();
  expect(parseVideoReceipt({ ...VALID_RECEIPT, dir: '/invalid/dir' })).toBeNull();
});

test('fitCellDimensions preserves aspect ratios up to 110 maxCols', async () => {
  const landscape = fitCellDimensions(1280, 720, 110, 40);
  expect(landscape.cols).toBeLessThanOrEqual(110);
  expect(landscape.rows).toBeGreaterThanOrEqual(1);

  const portrait = fitCellDimensions(1080, 1920, 110, 40);
  expect(portrait.cols).toBeLessThanOrEqual(110);
  expect(portrait.rows).toBeLessThanOrEqual(40);
});

test('extractVideoPayload parses wire marker and isolates rest text', async () => {
  const rawText = `Video ready\nawrit-video:${JSON.stringify(VALID_RECEIPT)}\nFooter note`;
  const { payload, rest } = extractVideoPayload(rawText);
  expect(payload).toEqual(VALID_RECEIPT);
  expect(rest).toBe('Video ready\nFooter note');
});

test('session.start registers awrit_video tool and awrit-video command', async ($, on) => {
  let registeredToolName = '';
  let registeredToolHasPath = false;
  let registeredCmdName = '';

  on('tool.register', async (_$, e) => {
    if (e.name === 'awrit_video') {
      registeredToolName = e.name;
      const properties = typeof e.inputSchema.properties === 'object' && e.inputSchema.properties !== null ? e.inputSchema.properties : {};
      registeredToolHasPath = 'path' in properties;
    }
    return { value: { tool: e.name } };
  });

  on('command.register', async (_$, e) => {
    if (e.name === 'awrit-video') {
      registeredCmdName = e.name;
    }
    return { value: { command: e.name } };
  });

  on('session.start', async () => ({ cwd: '/tmp' }));

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  expect(registeredToolName).toBe('awrit_video');
  expect(registeredToolHasPath).toBe(true);
  expect(registeredCmdName).toBe('awrit-video');
});

test('awrit_video tool dispatches CLI, validates receipt, and returns wire marker', async ($, on) => {
  let capturedArgv: readonly string[] = [];

  on('process.run', async (_$, e) => {
    capturedArgv = e.argv;
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify(VALID_RECEIPT),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  const statResult: FsStat = { kind: 'file', size: 1024, mtimeMs: 2000, isLink: false };
  on('fs.stat', async () => ({ value: statResult }));

  const result = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '/tmp/test-video.mp4',
    caption: 'Android record test',
  });

  expect(capturedArgv).toEqual(['awrit', 'video', '--json', '--', '/tmp/test-video.mp4']);
  expect(result.deny).toBeUndefined();
  expect(result.result).toContain('Video loaded (1280x720, 50 frames, 5s).');
  expect(result.result).toContain(`awrit-video:{"id":"${VALID_RECEIPT.id}"`);
  expect(result.result).toContain('"caption":"Android record test"');
});

test('awrit_video tool rejects flags, urls, control characters, and unexpected args', async ($) => {
  const flagRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '--flag',
  });
  expect(flagRes.deny).toContain('flags not allowed');

  const urlRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: 'https://example.com/v.mp4',
  });
  expect(urlRes.deny).toContain('URLs not allowed');

  const relRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: 'rel/video.mp4',
  });
  expect(relRes.deny).toContain('must be an absolute path');

  const ctrlRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '/tmp/\x1b/video.mp4',
  });
  expect(ctrlRes.deny).toContain('control characters not allowed');

  const unexpRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '/tmp/v.mp4',
    extra_bad_field: 123,
  });
  expect(unexpRes.deny).toContain('Unexpected argument');
});

test('awrit_video tool handles CLI failure', async ($, on) => {
  const runFail: ProcessRunResult = {
    exitCode: 1,
    stdout: JSON.stringify({ error: 'ffmpeg missing' }),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  };
  on('process.run', async () => ({ value: runFail }));

  const failRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '/tmp/v.mp4',
  });
  expect(failRes.deny).toContain('awrit video failed (exit code 1): ffmpeg missing');
});

test('awrit_video tool handles missing poster stat', async ($, on) => {
  const runOk: ProcessRunResult = {
    exitCode: 0,
    stdout: JSON.stringify(VALID_RECEIPT),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  };
  on('process.run', async () => ({ value: runOk }));
  on('fs.stat', async () => {
    throw new Error('ENOENT');
  });

  const statRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '/tmp/v.mp4',
  });
  expect(statRes.deny).toContain('Cannot verify video poster frame');
});

test('awrit-video slash command parses arguments and runs process', async ($, on) => {
  const runOk: ProcessRunResult = {
    exitCode: 0,
    stdout: JSON.stringify(VALID_RECEIPT),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  };
  on('process.run', async () => ({ value: runOk }));
  const statResult: FsStat = { kind: 'file', size: 1024, mtimeMs: 2000, isLink: false };
  on('fs.stat', async () => ({ value: statResult }));

  const empty = await $.command.run({
    command: 'awrit-video',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  });
  expect(empty.text).toContain('Usage: /awrit-video PATH [caption]');

  const res = await $.command.run({
    command: 'awrit-video',
    args: '"/tmp/test-video.mp4" Recorded screen',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  });
  expect(res.text).toContain('Video loaded (1280x720, 50 frames, 5s):');
  expect(res.text).toContain(`awrit-video:{"id":"${VALID_RECEIPT.id}"`);
  expect(res.text).toContain('"caption":"Recorded screen"');
});

test('renders ToolResult with Image and full player controls', async ($, _on) => {
  const marker = `awrit-video:${JSON.stringify(VALID_RECEIPT)}`;
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-vid-1',
    props: {
      tool_use_id: 'tu-vid-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: `Video summary:\n${marker}`,
      isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });

  const drawn = await ui.drawn();
  expect(drawn.type).toBe('Box');

  const img = await ui.find({ type: 'Image' });
  expect(img).toBeDefined();
  expect(img?.props.source).toEqual({
    file: VALID_RECEIPT.poster,
    format: 'png',
    generation: 1,
  });
  expect(img?.props.columns).toBeLessThanOrEqual(100);

  const playBtn = await ui.find({ key: 'video-play-req-vid-1' });
  expect(playBtn).toBeDefined();
  expect(playBtn?.props.label).toBe('▶');

  const back5Btn = await ui.find({ key: 'video-back5-req-vid-1' });
  expect(back5Btn).toBeDefined();
  const fwd5Btn = await ui.find({ key: 'video-fwd5-req-vid-1' });
  expect(fwd5Btn).toBeDefined();

  const openBtn = await ui.find({ key: 'video-open-req-vid-1' });
  expect(openBtn).toBeDefined();
  const copyBtn = await ui.find({ key: 'video-copy-req-vid-1' });
  expect(copyBtn).toBeDefined();

  // Track segments retain stable seek targets without percentage labels.
  for (let i = 0; i < 20; i++) {
    const seekBtn = await ui.find({ key: `video-seek-req-vid-1-${i}` });
    expect(seekBtn).toBeDefined();
    expect(seekBtn?.props.label).toMatch(/^[━●─]+$/);
  }
});

test('playback controls: seek blits target frame and pause cancels clock', async ($, on) => {
  const blitFiles: string[] = [];
  const blitGens: number[] = [];
  on('ui.blit', async (_$, e) => {
    if ('source' in e && 'file' in e.source) {
      blitFiles.push(e.source.file);
      if (typeof e.source.generation === 'number') blitGens.push(e.source.generation);
    }
    const res: UiBlitResult = {};
    return { value: res };
  });

  const marker = `awrit-video:${JSON.stringify(VALID_RECEIPT)}`;
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-playback-1',
    props: {
      tool_use_id: 'tu-playback-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: marker,
      isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });

  // Segment 9 of 20 -> frame 24 of 50
  await ui.press({ key: 'video-seek-req-playback-1-9' });

  expect(blitFiles.length).toBeGreaterThanOrEqual(1);
  expect(blitFiles[blitFiles.length - 1]).toBe(
    '/appdata/video-previews/vid-0123456789abcdef01234567/f00024.png',
  );
  expect(blitGens[blitGens.length - 1]).toBe(24);

  // Step forward +5s (50 frames max, should clamp to 50)
  await ui.press({ key: 'video-fwd5-req-playback-1' });
  expect(blitFiles[blitFiles.length - 1]).toBe(
    '/appdata/video-previews/vid-0123456789abcdef01234567/f00050.png',
  );
  expect(blitGens[blitGens.length - 1]).toBe(50);
});

test('timeline segments do not invert a whole block on hover', async ($) => {
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-hover-1',
    props: {
      tool_use_id: 'tu-hover-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: `awrit-video:${JSON.stringify(VALID_RECEIPT)}`,
      isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });
  const tree = JSON.stringify(await ui.drawn());
  for (let i = 0; i < 20; i++) {
    const at = tree.indexOf(`"key":"video-seek-req-hover-1-${i}"`);
    expect(at).toBeGreaterThan(-1);
    const chunk = tree.slice(at, at + 400);
    expect(chunk).toContain('"hover":{"inverse":false');
  }
  // At the start the playhead is the first glyph and the unplayed stretch is dimmed.
  const first = tree.indexOf('"key":"video-seek-req-hover-1-0"');
  expect(tree.slice(first, first + 400)).toContain('"label":"●─');
});

test('handles blit deny safely by pausing without crash', async ($, on) => {
  let blitAttempted = false;
  on('ui.blit', async () => {
    blitAttempted = true;
    return { value: { deny: 'surface shm exhausted' } };
  });

  const marker = `awrit-video:${JSON.stringify(VALID_RECEIPT)}`;
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-deny-1',
    props: {
      tool_use_id: 'tu-deny-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: marker,
      isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });

  await ui.press({ key: 'video-seek-req-deny-1-2' });
  expect(blitAttempted).toBe(true);

  const playBtn = await ui.find({ key: 'video-play-req-deny-1' });
  expect(playBtn?.props.label).toBe('▶');
});

test('pauses playback when scrolled offscreen (onScreen: null)', async ($, _on) => {
  const marker = `awrit-video:${JSON.stringify(VALID_RECEIPT)}`;
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-offscreen-1',
    props: {
      tool_use_id: 'tu-offscreen-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: marker,
      isErrored: false,
      onScreen: null,
    },
    viewport: { columns: 100, rows: 40 },
  });

  const playBtn = await ui.find({ key: 'video-play-req-offscreen-1' });
  expect(playBtn?.props.label).toBe('▶');
});

test('session.end cancels active player state', async ($, on) => {
  on('classic.SessionEnd', async () => ({}));
  const marker = `awrit-video:${JSON.stringify(VALID_RECEIPT)}`;
  await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-end-1',
    props: {
      tool_use_id: 'tu-end-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: marker,
      isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });

  await $.classic.SessionEnd({ reason: 'clear' });
});

test('mock.clock drives delayed autoplay and advancing frames', async ($, on) => {
  const clock = mock.clock(on);
  const blitGens: number[] = [];
  on('ui.blit', async (_$, e) => {
    if ('source' in e && 'generation' in e.source && typeof e.source.generation === 'number') {
      blitGens.push(e.source.generation);
    }
    return { value: {} };
  });

  const runOk: ProcessRunResult = {
    exitCode: 0,
    stdout: JSON.stringify(VALID_RECEIPT),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  };
  on('process.run', async () => ({ value: runOk }));
  const statResult: FsStat = { kind: 'file', size: 1024, mtimeMs: 2000, isLink: false };
  on('fs.stat', async () => ({ value: statResult }));

  const toolRes = await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_video',
    path: '/tmp/test-video.mp4',
  });
  expect(toolRes.result).toContain('awrit-video:');

  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'req-fresh-autoplay',
    props: {
      tool_use_id: 'tu-autoplay-1',
      tool: 'mcp__awrit-chat__awrit_video',
      output: toolRes.result,
      isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });

  // Advance clock by 100ms for delayed clock.after autoplay
  await clock.advance(100);
  // Advance by 100ms (1 frame interval at 10 fps)
  await clock.advance(100);
  expect(blitGens.length).toBeGreaterThanOrEqual(1);
  expect(blitGens[0]).toBe(2);

  // Advance another 100ms (frame 3)
  await clock.advance(100);
  expect(blitGens.length).toBeGreaterThanOrEqual(2);
  expect(blitGens[1]).toBe(3);

  // Pause playback via button
  await ui.press({ key: 'video-play-req-fresh-autoplay' });
  const countBefore = blitGens.length;
  await clock.advance(300);
  // No new blits while paused
  expect(blitGens.length).toBe(countBefore);
});

test('seeking during playback keeps advancing and pause still stops it', async ($, on) => {
  const clock = mock.clock(on);
  const generations: number[] = [];
  on('ui.blit', async (_$, e) => {
    if ('source' in e && typeof e.source.generation === 'number') {
      generations.push(e.source.generation);
    }
    return { value: {} };
  });
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'ToolResult',
    requestId: 'req-seek-playing',
    props: {
      tool_use_id: 'tu-seek-playing', tool: 'mcp__awrit-chat__awrit_video',
      output: `awrit-video:${JSON.stringify(VALID_RECEIPT)}`, isErrored: false,
    },
    viewport: { columns: 100, rows: 40 },
  });
  await ui.press({ key: 'video-play-req-seek-playing' });
  await clock.advance(100);
  expect(generations.at(-1)).toBe(2);
  await ui.press({ key: 'video-seek-req-seek-playing-9' });
  expect(generations.at(-1)).toBe(24);
  await clock.advance(100);
  expect(generations.at(-1)).toBe(25);
  await ui.press({ key: 'video-play-req-seek-playing' });
  const count = generations.length;
  await clock.advance(300);
  expect(generations.length).toBe(count);
  await ui.press({ key: 'video-seek-req-seek-playing-1' });
  expect(generations.at(-1)).toBe(4);
  const pausedCount = generations.length;
  await clock.advance(300);
  expect(generations.length).toBe(pausedCount);
});

test('seek waits for pending playback and does not steal a newly active player', async ($, on) => {
  const clock = mock.clock(on);
  const writes: string[] = [];
  let release = () => {};
  let started = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  on('ui.blit', async (_$, e) => {
    if ('source' in e) {
      writes.push(`${e.requestId}:${e.source.generation}`);
      if (e.requestId === 'req-race-a' && e.source.generation === 2) {
        started();
        await blocked;
      }
    }
    return { value: {} };
  });
  const mount = (id: string) => $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'ToolResult', requestId: id,
    props: { tool_use_id: id, tool: 'mcp__awrit-chat__awrit_video',
      output: `awrit-video:${JSON.stringify(VALID_RECEIPT)}`, isErrored: false },
    viewport: { columns: 100, rows: 40 },
  });
  const a = await mount('req-race-a');
  const b = await mount('req-race-b');
  await a.press({ key: 'video-play-req-race-a' });
  const advancing = clock.advance(100);
  await entered;
  await a.press({ key: 'video-seek-req-race-a-9' });
  expect(writes).toEqual(['req-race-a:2']);
  await b.press({ key: 'video-play-req-race-b' });
  release();
  await advancing;
  await clock.advance(300);
  expect(writes.includes('req-race-a:26')).toBe(false);
  expect(writes.some((write) => write.startsWith('req-race-b:'))).toBe(true);
});

test('pause during a pending seek prevents playback from resuming', async ($, on) => {
  const clock = mock.clock(on);
  let release = () => {};
  let started = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const generations: number[] = [];
  on('ui.blit', async (_$, e) => {
    if ('source' in e && typeof e.source.generation === 'number') {
      generations.push(e.source.generation);
      if (e.source.generation === 24) {
        started();
        await blocked;
      }
    }
    return { value: {} };
  });
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'ToolResult',
    requestId: 'req-pending-seek',
    props: { tool_use_id: 'tu-pending-seek', tool: 'mcp__awrit-chat__awrit_video',
      output: `awrit-video:${JSON.stringify(VALID_RECEIPT)}`, isErrored: false },
    viewport: { columns: 100, rows: 40 },
  });
  await ui.press({ key: 'video-play-req-pending-seek' });
  const seeking = ui.press({ key: 'video-seek-req-pending-seek-9' });
  await entered;
  await ui.press({ key: 'video-play-req-pending-seek' });
  release();
  await seeking;
  await clock.advance(300);
  expect(generations).toEqual([24]);
});

test('track segments fill the width exactly and map to frames', () => {
  for (const w of [1, 7, 24, 29, 61, 96]) {
    const widths = trackSegmentWidths(w);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(w);
    expect(widths.length).toBeLessThanOrEqual(20);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1);
  }
  expect(playheadSegment(1, 50, 20)).toBe(0);
  expect(playheadSegment(50, 50, 20)).toBe(19);
  expect(segmentTargetFrame(0, 20, 50)).toBe(1);
  expect(segmentTargetFrame(19, 20, 50)).toBe(50);
});

test('media card has a clickable track with start and end instead of percentage buttons', async ($, on) => {
  const generations: number[] = [];
  on('ui.blit', async (_$, e) => {
    if ('source' in e && typeof e.source.generation === 'number') generations.push(e.source.generation);
    return { value: {} };
  });
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'ToolResult', requestId: 'req-track',
    props: { tool_use_id: 'tu-track', tool: 'mcp__awrit-chat__awrit_video',
      output: `awrit-video:${JSON.stringify(VALID_RECEIPT)}`, isErrored: false },
    viewport: { columns: 100, rows: 40 },
  });
  const text = JSON.stringify(await ui.drawn());
  expect(text).toContain('Recorded video');
  expect(text).not.toContain('10%');
  expect(text).toContain('●');
  await ui.press({ key: 'video-seek-req-track-19' });
  expect(generations.at(-1)).toBe(50);
  await ui.press({ key: 'video-seek-req-track-0' });
  expect(generations.at(-1)).toBe(1);
});

test('bounds old player states when capacity exceeded', async ($, _on) => {
  for (let i = 0; i < 35; i++) {
    const id = `vid-0123456789abcdef0123456${i % 10}`;
    const dir = `/appdata/video-previews/${id}`;
    const poster = `${dir}/f00001.png`;
    const marker = `awrit-video:${JSON.stringify({ ...VALID_RECEIPT, id, dir, poster })}`;
    await $.ui.mount({
      plugin: 'awrit-chat',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: `req-bound-${i}`,
      props: {
        tool_use_id: `tu-bound-${i}`,
        tool: 'mcp__awrit-chat__awrit_video',
        output: marker,
        isErrored: false,
      },
      viewport: { columns: 100, rows: 40 },
    });
  }
});

test('awrit_video carries LLM text and layout; wide puts text left of the video, narrow and stacked do not', async ($, on) => {
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: JSON.stringify(VALID_RECEIPT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }));
  on('fs.stat', async () => ({ value: { kind: 'file', size: 1024, mtimeMs: 2000, isLink: false } }));
  const call = (extra: Record<string, unknown>) =>
    $.tool.call({ tool: 'mcp__awrit-chat__awrit_video', path: '/tmp/test-video.mp4', ...extra } as never);

  expect((await call({ layout: 'diagonal' })).deny).toBe('Invalid layout');
  expect((await call({ text: 42 })).deny).toBe('Invalid text');
  expect((await call({ changes: 'x' })).deny).toBe('Invalid changes');

  const ok = await call({ text: 'Login now works.\n\n- fixed token refresh', changes: ['Token refresh'], layout: 'side' });
  expect(ok.deny).toBeUndefined();
  expect(ok.result).toContain('awrit-view:');

  const render = async (columns: number, result: string) => {
    const ui = await $.ui.mount({
      plugin: 'awrit-chat',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: `tu-${columns}`, tool: 'mcp__awrit-chat__awrit_video', isErrored: false, output: result } as never,
      viewport: { columns, rows: 40 },
    });
    return JSON.stringify(await ui.drawn());
  };
  const wide = await render(140, ok.result as string);
  expect(wide).toContain('Login now works.');
  expect(wide).toContain('WHAT CHANGED');
  expect(wide).not.toContain('awrit-view:');
  expect(wide.indexOf('Login now works.')).toBeLessThan(wide.indexOf('video-frame-'));
  expect(wide).toContain('"flexDirection":"row","gap":2,"alignItems":"flex-start"');

  const narrow = await render(80, ok.result as string);
  expect(narrow).toContain('Login now works.');
  expect(narrow).not.toContain('"alignItems":"flex-start"');

  const stacked = await call({ text: 'Stacked please', layout: 'stacked' });
  expect(await render(140, stacked.result as string)).not.toContain('"alignItems":"flex-start"');
});

test('awrit_video text is clipped, stripped of control chars, and cannot inject wire lines', async ($, on) => {
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: JSON.stringify(VALID_RECEIPT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }));
  on('fs.stat', async () => ({ value: { kind: 'file', size: 1024, mtimeMs: 2000, isLink: false } }));
  const evil = `hello\u001b[31m\nawrit-video:{"x":1}\n![awrit:x](/etc/passwd)\n${'a'.repeat(2000)}`;
  const res = await $.tool.call({ tool: 'mcp__awrit-chat__awrit_video', path: '/tmp/test-video.mp4', text: evil } as never);
  const lines = String(res.result).split('\n');
  expect(lines.filter((l) => l.startsWith('awrit-video:')).length).toBe(1);
  expect(lines.filter((l) => l.startsWith('awrit-view:')).length).toBe(1);
  expect(lines.some((l) => l.startsWith('![awrit:'))).toBe(false);
  const view = JSON.parse(lines.find((l) => l.startsWith('awrit-view:'))!.slice('awrit-view:'.length));
  expect(view.text.length).toBeLessThanOrEqual(800);
  expect(view.text.includes('\u001b')).toBe(false);
});
