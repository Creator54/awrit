import { test, expect } from 'claude-code/testing';

const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('renders Box with Image and removes marker on terminal', async ($, on) => {
  let passedToHost: any = null;

  on('fs.stat' as any, async ($: any, e: any) => {
    return {
      value: {
        kind: 'file',
        size: 500,
        mtimeMs: 1000,
        isLink: false,
      },
    };
  });

  on('fs.read' as any, async ($: any, e: any) => {
    return {
      value: {
        base64: VALID_PNG_BASE64,
      },
    };
  });

  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    passedToHost = e;
    const { Text } = $.ui.resolve(e);
    return Text({ children: e.props.text });
  });

  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: {
      text: 'First line of explanation\n![awrit:device screen](/tmp/valid-screen.png)\nFinal remark',
      isFirstOfReply: true,
    },
    viewport: {
      columns: 100,
      rows: 40,
    },
  });

  expect(passedToHost).toBeNull();

  const drawn = await ui.drawn();
  expect(drawn.type).toBe('Box');
  expect((drawn as any).props?.flexDirection).toBe('row');
  expect((drawn as any).children).toBeDefined();

  const columns = (drawn as any).children;
  expect(columns[0].children[0].type).toBe('Markdown');
  expect(columns[0].children[0].props.text).toBe('First line of explanation\n\nFinal remark');
  expect(columns[0].props.width).toBe(53);
  expect(columns[1].props.width).toBe(45);
  expect((drawn as any).props.gap).toBe(2);
  expect((drawn as any).props.alignItems).toBe('flex-start');
  const imgChild = columns[1].children.find((c: any) => c.type === 'Image');
  expect(imgChild).toBeDefined();
  expect(imgChild.props.alt).toBe('device screen');
  expect(imgChild.props.columns).toBeGreaterThanOrEqual(1);
  expect(imgChild.props.columns).toBeLessThanOrEqual(255);
  expect(imgChild.props.rows).toBeGreaterThanOrEqual(1);
  expect(imgChild.props.rows).toBeLessThanOrEqual(255);
});

test('stacks vertically when viewport width is narrow (<70 cols)', async ($, on) => {
  on('fs.stat' as any, async () => ({
    value: { kind: 'file', size: 500, mtimeMs: 1000, isLink: false },
  }));
  on('fs.read' as any, async () => ({
    value: { base64: VALID_PNG_BASE64 },
  }));
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: e.props.text });
  });

  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: {
      text: 'Narrow text\n![awrit:narrow cap](/tmp/screen.png)',
      isFirstOfReply: true,
    },
    viewport: {
      columns: 50,
      rows: 30,
    },
  });

  const drawn = await ui.drawn();
  expect(drawn.type).toBe('Box');
  expect((drawn as any).props?.flexDirection).toBe('column');
});

test('preserves non-terminal surfaces without modification', async ($, on) => {
  let passedE: any = null;
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    passedE = e;
    const { Text } = $.ui.resolve(e);
    return Text({ children: e.props.text });
  });

  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: {
      text: 'Message with ![awrit:cap](/tmp/img.png)',
      isFirstOfReply: true,
    },
  });

  expect(passedE).toBeDefined();
  expect(passedE.surface).toBe('desktop');
  expect(passedE.props.text).toBe('Message with ![awrit:cap](/tmp/img.png)');
  const drawn = await ui.drawn();
  expect(drawn.type).toBe('Text');
});

test('falls back cleanly on unsafe paths or missing files', async ($, on) => {
  let passedE: any = null;
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    passedE = e;
    const { Text } = $.ui.resolve(e);
    return Text({ children: e.props.text });
  });

  // Relative path or path traversal
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: {
      text: 'Look here:\n![awrit:bad](/tmp/../etc/shadow.png)',
      isFirstOfReply: true,
    },
  });

  expect(passedE.props.text).toContain('![awrit:bad](/tmp/../etc/shadow.png)');
  const drawn = await ui.drawn();
  expect(drawn.type).toBe('Text');
});

test('prompt.compose injects awrit instructions when loaded', async ($, on) => {
  on('prompt.compose', async () => ({
    sections: [
      { id: 'intro', text: 'Intro text', scope: 'shared' as const },
    ],
  }));

  const res = await $.prompt.compose({
    model: 'claude-3-5-sonnet',
    promptModel: 'claude-3-5-sonnet',
    surfaces: ['terminal'],
    tools: ['Bash'],
    outputStyle: null,
    traits: [],
  });

  const awritSection = res.sections.find((s) => s.id === 'awrit-chat:instructions');
  expect(awritSection).toBeDefined();
  expect(awritSection?.scope).toBe('session');
  expect(awritSection?.text).toContain('/awrit-pane');
  expect(awritSection?.text).not.toContain('Alt+D');
});

 test('reallocates text width when the same reply is rendered at another viewport width', async ($, on) => {
  on('fs.stat' as any, async () => ({ value: { kind: 'file', size: 500, mtimeMs: 1000, isLink: false } }));
  on('fs.read' as any, async () => ({ value: { base64: VALID_PNG_BASE64 } }));
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: e.props.text });
  });
  for (const width of [120, 80, 50]) {
    const ui = await $.ui.mount({
      plugin: 'awrit-chat', surface: 'terminal', component: 'AssistantMessage',
      props: { text: 'Explanation that must wrap beside the media.\n![awrit:resize](/tmp/resize.png)', isFirstOfReply: true },
      viewport: { columns: width, rows: 40 },
    });
    const drawn = await ui.drawn() as any;
    expect(drawn.props.width).toBe(width);
    expect(drawn.props.flexDirection).toBe(width < 70 ? 'column' : 'row');
    if (width >= 70) {
      expect(drawn.children[0].props.width + drawn.children[1].props.width + drawn.props.gap).toBe(width);
      expect(drawn.children[0].props.flexShrink).toBe(0);
    }
  }
});

test('preserves ordinary replies without replacing the host renderer', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    return $.ui.resolve(e).Text({ children: e.props.text });
  });
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'AssistantMessage',
    props: { text: 'Ordinary reply without media.', isFirstOfReply: true },
    viewport: { columns: 100, rows: 40 },
  });
  expect((await ui.drawn()).type).toBe('Text');
});

test('renders image-only replies without an empty Markdown column', async ($, on) => {
  on('fs.stat' as any, async () => ({ value: { kind: 'file', size: 500, mtimeMs: 1000, isLink: false } }));
  on('fs.read' as any, async () => ({ value: { base64: VALID_PNG_BASE64 } }));
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'AssistantMessage',
    props: { text: '![awrit:image only](/tmp/image-only.png)', isFirstOfReply: true },
    viewport: { columns: 100, rows: 40 },
  });
  const drawn = await ui.drawn() as any;
  expect(drawn.children.length).toBe(1);
  expect(drawn.children[0].type).toBe('Image');
});

test('workspace pane renders interactive controls and provides close control', async ($, on) => {
  let closed = '';
  on('ui.close', async ($, e) => { closed = e.id; return { value: undefined }; });
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'Pane', requestId: 'awrit-workspace',
    props: { title: 'Awrit workspace', isFocused: false, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    viewport: { columns: 120, rows: 40 },
  });
  const drawn = await ui.drawn() as any;
  expect(drawn.type).toBe('Box');
  // Header with title
  expect(drawn.children[0].children[0].children).toContain('📱 Awrit Android');
  // Button bar with actions
  const buttonBar = drawn.children[2];
  expect(buttonBar.children.some((btn: any) => btn.props.key === 'btn-pane-refresh')).toBe(true);
  expect(buttonBar.children.some((btn: any) => btn.props.key === 'btn-pane-back')).toBe(true);
  expect(buttonBar.children.some((btn: any) => btn.props.key === 'btn-pane-home')).toBe(true);
  expect(buttonBar.children.some((btn: any) => btn.props.key === 'btn-pane-recents')).toBe(true);
  expect(buttonBar.children.some((btn: any) => btn.props.key === 'close-workspace')).toBe(true);
  await ui.press({ key: 'close-workspace' });
  expect(closed).toBe('awrit-workspace');
});

test('workspace commands open without requesting focus and close without touching devices', async ($, on) => {
  const opened: any[] = [];
  const closed: string[] = [];
  on('ui.open', async ($, e) => { opened.push(e); return { value: { isPlaced: true } }; });
  on('ui.close', async ($, e) => { closed.push(e.id); return { value: undefined }; });
  const resultRefresh = await $.command.run({ command: 'awrit-pane', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(resultRefresh.text).toContain('Awrit visual workspace opened beside chat');

  const result = await $.command.run({ command: 'awrit-pane', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(result.text).toContain('Awrit visual workspace opened beside chat');
  expect(opened.length).toBe(2);
  expect(opened[0].id).toBe('awrit-workspace');
  expect(opened[0].focus).toBeUndefined();
  await $.command.run({ command: 'awrit-pane', args: 'close', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(closed).toEqual(['awrit-workspace']);
  const invalid = await $.command.run({ command: 'awrit-pane', args: 'bad arg!', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(invalid.text).toBe('Usage: /awrit-pane [SERIAL|refresh|close]');
  expect(opened.length).toBe(2);
  expect(closed.length).toBe(1);
});

test('awrit-overlay command delegates to process.run and formats responses', async ($, on) => {
  on('process.run' as any, async ($: any, e: any) => {
    if (e.argv.includes('status')) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ action: 'status', open: true, target: '127.0.0.1:5558', id: 5 }), stderr: '' } };
    }
    if (e.argv.includes('close')) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ action: 'closed', previousId: 5, source: 1 }), stderr: '' } };
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ action: 'opened', id: 9, target: '127.0.0.1:5558', resumed: true, viewerRunning: true }), stderr: '' } };
  });

  const resStatus = await $.command.run({ command: 'awrit-overlay', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(resStatus.text).toBe('Overlay is open for 127.0.0.1:5558 (window 5).');

  const resClose = await $.command.run({ command: 'awrit-overlay', args: 'close', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(resClose.text).toBe('Closed overlay (window 5). Chat focus restored.');

  const resOpen = await $.command.run({ command: 'awrit-overlay', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(resOpen.text).toBe('Resumed overlay for 127.0.0.1:5558 (window 9, viewer running). Press Escape to return to chat.');
});

test('awrit-capture command delegates to process.run and returns marker', async ($, on) => {
  on('process.run' as any, async ($: any, e: any) => {
    return { value: { exitCode: 0, stdout: JSON.stringify({ width: 1080, height: 1920, id: 'cap-123456789abc', marker: '![awrit:caption](/path/to/cap.png)' }), stderr: '' } };
  });

  const res = await $.command.run({ command: 'awrit-capture', args: 'Important bug', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  expect(res.text).toContain('Captured 1080x1920 image (cap-123456789abc)');
  expect(res.text).toContain('![awrit:caption](/path/to/cap.png)');
});

test('awrit-capture command row renders marker as an inline image', async ($, on) => {
  on('fs.stat' as any, async () => ({ value: { kind: 'file', size: 500, mtimeMs: 1, isLink: false } }));
  on('fs.read' as any, async () => ({ value: { base64: VALID_PNG_BASE64 } }));
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'awrit-capture', args: '', text: 'Captured 2x2 image (cap-0123456789ab):\n![awrit:shot](/tmp/cap.png)', isErrored: false } as any,
    viewport: { columns: 100, rows: 40 },
  });
  const drawn = await ui.drawn() as any;
  expect(drawn.type).toBe('Box');
  expect(drawn.children.some((c: any) => c.type === 'Image')).toBe(true);
  expect(JSON.stringify(drawn)).toContain('Copy path');
});

test('awrit_capture tool result renders its marker as an inline image', async ($, on) => {
  on('fs.stat' as any, async () => ({ value: { kind: 'file', size: 500, mtimeMs: 1, isLink: false } }));
  on('fs.read' as any, async () => ({ value: { base64: VALID_PNG_BASE64 } }));
  const ui = await $.ui.mount({
    plugin: 'awrit-chat', surface: 'terminal', component: 'ToolResult',
    props: {
      tool_use_id: 'tu-1', tool: 'mcp__awrit-chat__awrit_capture', isErrored: false,
      output: [{ type: 'text', text: 'Shown to the user: 2x2 capture (cap-0123456789ab).\n![awrit:shot](/tmp/cap.png)' }],
    } as any,
    viewport: { columns: 100, rows: 40 },
  });
  const drawn = await ui.drawn() as any;
  expect(drawn.type).toBe('Box');
  expect(drawn.children.some((c: any) => c.type === 'Image')).toBe(true);
  expect(JSON.stringify(drawn)).toContain('Copy path');
});

test('awrit_capture result shows what changed and QA beside the image on wide terminals, below on narrow', async ($, on) => {
  on('fs.stat' as any, async () => ({ value: { kind: 'file', size: 500, mtimeMs: 1, isLink: false } }));
  on('fs.read' as any, async () => ({ value: { base64: VALID_PNG_BASE64 } }));
  const view = JSON.stringify({ changes: ['Annual toggle sets prices'], summary: [{ label: 'Billing', ok: true, passed: 1, total: 1 }] });
  const output = `Shown.\n![awrit:shot](/tmp/cap.png)\nawrit-view:${view}`;
  for (const columns of [140, 80]) {
    const ui = await $.ui.mount({
      plugin: 'awrit-chat', surface: 'terminal', component: 'ToolResult',
      props: { tool_use_id: `tu-${columns}`, tool: 'mcp__awrit-chat__awrit_capture', isErrored: false, output } as any,
      viewport: { columns, rows: 40 },
    });
    const tree = JSON.stringify(await ui.drawn());
    expect(tree).toContain('WHAT CHANGED');
    expect(tree).toContain('Annual toggle sets prices');
    expect(tree).toContain('QA (agent-reported)');
    expect(tree).toContain('✓ Billing (1/1)');
    expect(tree).not.toContain('awrit-view:');
    expect(tree.includes('"flexDirection":"row","gap":2,"alignItems":"flex-start"')).toBe(columns >= 110);
  }
});

test('awrit_capture tool dispatches via $.tool.call, validates receipt, and formats result with QA', async ($, on) => {
  let capturedArgv: string[] = [];
  on('process.run' as any, async ($: any, e: any) => {
    capturedArgv = e.argv;
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({
          width: 1080,
          height: 1920,
          id: 'cap-123456789abc',
          marker: '![awrit:caption](/path/to/cap.png)',
        }),
        stderr: '',
      },
    };
  });

  const res = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
    prompt_id: 'p-1',
    permission_mode: 'default',
    agent_id: 'a-1',
    comment: 'Inspect bug',
    changes: ['Updated banner'],
    summary: [{ label: 'Visual test', ok: true, passed: 2, total: 2 }],
  } as any)) as any;

  expect(capturedArgv).toEqual(['awrit', 'capture', '--comment', 'Inspect bug', '--json']);
  expect(res.result).toContain('Captured; inline preview: 1080x1920 capture (cap-123456789abc).');
  expect(res.result).toContain('![awrit:caption](/path/to/cap.png)');
  expect(res.result).toContain('awrit-view:');
  expect(res.result).toContain('Visual test');
});

test('awrit_capture tool rejects removed adb and option-shaped targets', async ($, on) => {
  const adb = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
    adb: 'emulator-5554',
  } as any)) as any;
  expect(adb.deny).toContain('awrit device view NAME');

  const optionTarget = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
    target: '--malicious-flag',
  } as any)) as any;
  expect(optionTarget.deny).toContain('Invalid target');

  const contradictory = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
    summary: [{ label: 'Suite', ok: true, passed: 1, total: 2 }],
  } as any)) as any;
  expect(contradictory.deny).toContain('cannot be ok');

  const badCounts = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
    summary: [{ label: 'Suite', ok: false, passed: 5, total: 2 }],
  } as any)) as any;
  expect(badCounts.deny).toContain('Invalid summary counts');
});

test('awrit_capture tool handles CLI failures and malformed receipts, and caps portrait image height', async ($, on) => {
  on('process.run' as any, async ($: any, e: any) => {
    if (e.argv.includes('offline-device')) {
      return { value: { exitCode: 1, stdout: '', stderr: 'device offline' } };
    }
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ width: -10, height: 0, id: 'bad', marker: 'not-a-marker' }),
        stderr: '',
      },
    };
  });

  on('fs.stat' as any, async () => ({ value: { kind: 'file', size: 500, mtimeMs: 1, isLink: false } }));
  // PNG header with width: 1080, height: 2400 (aspect 0.45)
  const PORTRAIT_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAABDgAAAlgCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  on('fs.read' as any, async () => ({ value: { base64: PORTRAIT_PNG_BASE64 } }));

  const failedCli = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
    target: 'offline-device',
  } as any)) as any;
  expect(failedCli.deny).toContain('awrit capture failed (exit code 1): device offline');

  const badReceipt = (await $.tool.call({
    tool: 'mcp__awrit-chat__awrit_capture',
  } as any)) as any;
  expect(badReceipt.deny).toContain('Invalid capture dimensions');

  // Portrait image in a 30-row viewport:
  // Rows must be capped to available viewport minus controls (30 - 4 = 26) and columns shrunk proportionally below 45.
  const ui = await $.ui.mount({
    plugin: 'awrit-chat',
    surface: 'terminal',
    component: 'ToolResult',
    props: {
      tool_use_id: 'tu-portrait',
      tool: 'mcp__awrit-chat__awrit_capture',
      isErrored: false,
      output: 'Captured:\n![awrit:phone](/tmp/phone.png)',
    } as any,
    viewport: { columns: 100, rows: 30 },
  });

  const drawn = (await ui.drawn()) as any;
  const img = drawn.children.find((c: any) => c.type === 'Image') || drawn.children[1]?.children?.find((c: any) => c.type === 'Image') || drawn.children[0]?.children?.find((c: any) => c.type === 'Image');
  expect(img).toBeDefined();
  expect(img.props.rows).toBeLessThanOrEqual(26);
  expect(img.props.columns).toBeLessThan(45);
  const ratio = img.props.columns / img.props.rows;
  expect(ratio).toBeGreaterThan(0.7);
  expect(ratio).toBeLessThan(1.1);
});