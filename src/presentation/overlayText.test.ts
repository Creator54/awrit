import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { applyOverlayText, decodeOverlayTextRequest, updateOverlayText } from './overlayText';

const target = 'file:///home/me/.local/share/awrit/video-pages/page-abc123/index.html';

interface FakeElement {
  className: string;
  textContent?: string;
  before?: (element: FakeElement) => void;
  remove?: () => void;
}

/** Just enough DOM for the overlay text script: `.card-text` beside `.card-video`. */
function fakePage(url: string) {
  const nodes = new Map<string, FakeElement>();
  const video: FakeElement = {
    className: 'card-video',
    before: (element) => nodes.set(`.${element.className}`, element),
  };
  nodes.set('.card-video', video);
  const document = {
    querySelector: (selector: string) => nodes.get(selector) ?? null,
    createElement: (): FakeElement => {
      const element: FakeElement = { className: '' };
      element.remove = () => {
        for (const [selector, node] of nodes) if (node === element) nodes.delete(selector);
      };
      return element;
    },
  };
  return {
    nodes,
    getURL: () => url,
    executeJavaScript: async (code: string) => vm.runInNewContext(code, { document }),
  };
}

test('updateOverlayText fails clearly when no overlay is open for the window', async () => {
  await expect(updateOverlayText({ sourceWindowId: 987654, text: 'hi' })).rejects.toThrow(
    'No overlay is open to update',
  );
});

test('updateOverlayText validates the text before touching any viewer', async () => {
  await expect(updateOverlayText({ sourceWindowId: 987654, text: 'bad\u0007' })).rejects.toThrow(
    'invalid control characters',
  );
});

test('overlay text requests are accepted only for generated video pages', () => {
  expect(() => decodeOverlayTextRequest(null)).toThrow('Invalid overlay text request');
  expect(() => decodeOverlayTextRequest({ target: 'https://example.com/index.html' })).toThrow(
    'Invalid overlay text target',
  );
  expect(() => decodeOverlayTextRequest({ target, text: 42 })).toThrow(
    'Video page text must be a string',
  );
  expect(decodeOverlayTextRequest({ target, text: '   ' })).toEqual({ target });
  expect(decodeOverlayTextRequest({ target, text: 'hi' })).toEqual({ target, text: 'hi' });
});

test('overlay text goes only to the page showing that overlay', async () => {
  const page = fakePage(target);
  const other = target.replace('abc123', 'other1');
  await expect(applyOverlayText([page], { target: other, text: 'hi' })).rejects.toThrow(
    'The overlay viewer is not showing that video',
  );
});

test('overlay text is set and removed as inert text beside the video', async () => {
  const page = fakePage(target);
  const text = '"); globalThis.pwned = true; //';
  expect(await applyOverlayText([page], { target, text })).toBe('set');
  expect(page.nodes.get('.card-text')?.textContent).toBe(text);
  expect(await applyOverlayText([page], { target })).toBe('removed');
  expect(page.nodes.has('.card-text')).toBe(false);
});

test('a page that rejects the update reports it clearly', async () => {
  const page = {
    getURL: () => target,
    executeJavaScript: async () => {
      throw new Error('Script failed');
    },
  };
  await expect(applyOverlayText([page], { target, text: 'hi' })).rejects.toThrow(
    'The overlay page rejected the text update',
  );
});
