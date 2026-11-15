import { expect, test } from 'bun:test';
import { getTabThumbnail, rememberTabThumbnail } from './tabThumbnail';

test('thumbnail cache is bounded, throttled and isolated by contents', () => {
  const page = {};
  const other = {};
  let resizes = 0;
  const image = {
    getSize: () => ({ width: 1920, height: 1080 }),
    resize: (size: { width: number; height: number }) => {
      resizes++;
      expect(size).toEqual({ width: 320, height: 180 });
      return { toJPEG: () => Buffer.from('preview') };
    },
  };
  rememberTabThumbnail(page, image, 1000);
  expect(getTabThumbnail(page)).toBe('data:image/jpeg;base64,cHJldmlldw==');
  expect(getTabThumbnail(other)).toBeUndefined();
  rememberTabThumbnail(page, image, 1100);
  expect(resizes).toBe(1);
  rememberTabThumbnail(page, image, 2100);
  expect(resizes).toBe(2);
});

test('empty or oversized thumbnail data is not retained', () => {
  const page = {};
  rememberTabThumbnail(page, {
    getSize: () => ({ width: 0, height: 0 }),
    resize: () => {
      throw new Error('empty image');
    },
  });
  expect(getTabThumbnail(page)).toBeUndefined();
  rememberTabThumbnail(page, {
    getSize: () => ({ width: 320, height: 180 }),
    resize: () => ({ toJPEG: () => Buffer.alloc(100_000) }),
  });
  expect(getTabThumbnail(page)).toBeUndefined();
});
