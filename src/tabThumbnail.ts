interface ThumbnailImage {
  getSize(): { width: number; height: number };
  resize(size: { width: number; height: number }): { toJPEG(quality: number): Buffer };
}

// Weak keys release the preview with its webContents; no full-size frames are retained.
const previews = new WeakMap<object, { at: number; data?: string }>();

export function rememberTabThumbnail(page: object, image: ThumbnailImage, now = Date.now()): void {
  const previous = previews.get(page);
  if (previous && now - previous.at < 1000) return;
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return;
  const scale = Math.min(1, 320 / width, 240 / height);
  const jpeg = image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    })
    .toJPEG(65);
  previews.set(page, {
    at: now,
    data:
      jpeg.length <= 64 * 1024
        ? `data:image/jpeg;base64,${jpeg.toString('base64')}`
        : previous?.data,
  });
}

export function getTabThumbnail(page: object): string | undefined {
  return previews.get(page)?.data;
}
