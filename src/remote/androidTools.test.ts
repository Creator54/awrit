import { describe, expect, test } from 'bun:test';
import { createAndroidTools, matchApp, parseUiDump } from './androidTools';

const APPS = [
  'com.android.settings/.Settings',
  'com.android.chrome/com.google.android.apps.chrome.Main',
  'in.devswork.soma.debug/.ui.HomeActivity',
  'com.google.android.apps.messaging/.ui.ConversationListActivity',
  'com.google.android.apps.photos/.home.HomeActivity',
];

const SCREEN = { width: 1080, height: 2400 };

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
<node text="Sign in &amp; go" resource-id="com.app:id/login" class="android.widget.Button" clickable="true" enabled="true" bounds="[100,200][300,300]" />
<node text="" content-desc="Search" class="android.widget.ImageView" clickable="false" bounds="[0,0][100,100]" />
<node text="" class="android.widget.EditText" clickable="true" focused="true" password="true" bounds="[0,400][1080,500]" />
<node text="Hidden" class="android.widget.TextView" bounds="[0,3000][1080,3100]" />
<node text="" class="android.widget.LinearLayout" bounds="[0,0][10,10]" />
</node></hierarchy>`;

function harness(xml = DUMP) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const shown: string[] = [];
  const tools = createAndroidTools({
    size: () => SCREEN,
    dump: async () => xml,
    apps: async () => APPS,
    post: async (path, body) => {
      posts.push({ path, body });
      shown.push(`post ${path}`);
    },
    preview: async (at, label, press) => {
      shown.push(`show ${label} ${at.x},${at.y}${press ? ' press' : ''}`);
    },
  });
  return { tools, posts, shown };
}

test('shows the agent cursor before each action and ignores preview failures', async () => {
  const { tools, shown } = harness();
  await tools.call('click', { x: 10, y: 20 });
  await tools.call('open', { app: 'settings' });
  await tools.call('key', { key: 'back' });
  expect(shown).toEqual([
    'show tap 10,20 press',
    'post /tap',
    `show open com.android.settings ${SCREEN.width / 2},${SCREEN.height / 2}`,
    'post /launch',
    `show press back ${SCREEN.width / 2},${SCREEN.height - 40} press`,
    'post /key',
  ]);
  const failing = createAndroidTools({
    size: () => SCREEN,
    dump: async () => DUMP,
    apps: async () => APPS,
    post: async () => {},
    preview: async () => {
      throw new Error('page gone');
    },
  });
  expect(await failing.call('click', { x: 1, y: 1 })).toEqual({ ok: true, x: 1, y: 1 });
});

test('scroll until swipes until the text appears, and stops at the end of the content', async () => {
  const row = (text: string) =>
    `<hierarchy><node text="${text}" class="android.widget.TextView" bounds="[0,100][1080,200]" /></hierarchy>`;
  const screens = [row('Network'), row('Battery'), row('About phone')];
  let shown = 0;
  const swipes: unknown[] = [];
  const tools = createAndroidTools({
    size: () => SCREEN,
    dump: async () => screens[Math.min(shown, screens.length - 1)],
    apps: async () => APPS,
    post: async (path, body) => {
      swipes.push({ path, body });
      shown += 1;
    },
  });
  const found = (await tools.call('scroll', { direction: 'down', until: 'about' })) as {
    found: boolean;
    nodes: Array<{ ref: string; name: string }>;
  };
  expect(found.found).toBe(true);
  expect(swipes).toHaveLength(2);
  expect(found.nodes.map((node) => node.name)).toEqual(['About phone']);
  // The returned refs are live.
  expect(await tools.call('click', { ref: found.nodes[0].ref })).toMatchObject({ ok: true });
  expect(await tools.call('scroll', { direction: 'down', until: 'missing' })).toMatchObject({
    found: false,
    end: true,
    swipes: 1,
  });
});

test('a failed snapshot tells the agent to capture and click by x/y', async () => {
  const tools = createAndroidTools({
    size: () => SCREEN,
    dump: async () => {
      throw new Error('Android device refused /ui (502): ERROR: could not get idle state.');
    },
    apps: async () => APPS,
    post: async () => {},
  });
  await expect(tools.call('snapshot', {})).rejects.toThrow(
    /could not get idle state.*capture the screen and click by x\/y/,
  );
});

describe('parseUiDump', () => {
  test('keeps named or actionable on-screen elements with tap centers', () => {
    const { nodes, truncated } = parseUiDump(DUMP, 'a1', SCREEN);
    expect(truncated).toBe(false);
    expect(nodes).toEqual([
      {
        ref: 'a1:e1',
        role: 'Button',
        name: 'Sign in & go',
        id: 'login',
        states: ['clickable'],
        x: 200,
        y: 250,
      },
      { ref: 'a1:e2', role: 'ImageView', name: 'Search', x: 50, y: 50 },
      {
        ref: 'a1:e3',
        role: 'EditText',
        states: ['clickable', 'editable', 'focused', 'password'],
        x: 540,
        y: 450,
      },
    ]);
  });
});

describe('android tools', () => {
  test('clicks and types through snapshot refs, which expire after an action', async () => {
    const { tools, posts } = harness();
    await tools.call('snapshot', {});
    expect(await tools.call('click', { ref: 'a1:e1' })).toEqual({ ok: true, x: 200, y: 250 });
    await expect(tools.call('type', { ref: 'a1:e3', text: 'hi' })).rejects.toThrow('expired ref');
    await tools.call('snapshot', { query: 'edit' });
    await tools.call('type', { ref: 'a2:e3', text: 'hi there' });
    expect(posts).toEqual([
      { path: '/tap', body: { x: 200, y: 250 } },
      { path: '/tap', body: { x: 540, y: 450 } },
      { path: '/text', body: { text: 'hi there' } },
    ]);
  });

  test('filters snapshots by query and explains an empty tree', async () => {
    const filtered = (await harness().tools.call('snapshot', { query: 'search' })) as {
      nodes: Array<{ name: string }>;
    };
    expect(filtered.nodes.map((n) => n.name)).toEqual(['Search']);
    expect(await harness('<hierarchy/>').tools.call('snapshot', {})).toMatchObject({
      nodes: [],
      note: expect.stringContaining('click by x/y'),
    });
  });

  test('presses key lists and rejects unknown keys before sending any', async () => {
    const { tools, posts } = harness();
    await tools.call('key', { keys: ['Back', 'home', 'Arrow_Down'] });
    await expect(tools.call('key', { keys: ['enter', 'f13'] })).rejects.toThrow('Unknown key f13');
    expect(posts.map((p) => p.body.keycode)).toEqual([
      'KEYCODE_BACK',
      'KEYCODE_HOME',
      'KEYCODE_DPAD_DOWN',
    ]);
  });

  test('scrolls by swiping against the direction and checks points', async () => {
    const { tools, posts } = harness();
    await tools.call('scroll', { direction: 'down' });
    expect(posts[0]).toEqual({
      path: '/swipe',
      body: { x1: 540, y1: 1560, x2: 540, y2: 840, ms: 300 },
    });
    await tools.call('scroll', { direction: 'left', x: 5, y: 7 });
    expect(posts[1].body).toEqual({ x1: 0, y1: 7, x2: 324, y2: 7, ms: 300 });
    await expect(tools.call('click', { x: 1080, y: 5 })).rejects.toThrow('inside the 1080x2400');
    await expect(tools.call('type', { text: 'é' })).rejects.toThrow('printable ASCII');
  });

  test('opens apps by name or package and lists them when unsure', async () => {
    expect(matchApp(APPS, 'Settings')).toBe('com.android.settings/.Settings');
    expect(matchApp(APPS, 'com.android.chrome')).toBe(APPS[1]);
    expect(matchApp(APPS, 'soma')).toBe(APPS[2]);
    expect(() => matchApp(APPS, 'apps')).toThrow('Several apps match "apps"; use a package:');
    expect(() => matchApp(APPS, 'maps')).toThrow(
      'No app matches "maps"; use a package: com.android.settings',
    );
    const { tools, posts } = harness();
    await tools.call('snapshot', {});
    expect(await tools.call('open', { app: 'settings' })).toEqual({
      ok: true,
      opened: 'com.android.settings/.Settings',
    });
    expect(posts).toEqual([
      { path: '/launch', body: { component: 'com.android.settings/.Settings' } },
    ]);
    await expect(tools.call('click', { ref: 'a1:e1' })).rejects.toThrow('expired ref');
  });
});
