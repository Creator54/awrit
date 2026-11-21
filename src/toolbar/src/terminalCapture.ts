/**
 * Make the terminal's default background see-through so the review follows
 * Kitty's own background and opacity. Kitty's screenshot stores that
 * background pre-multiplied by the opacity, so un-multiply before comparing.
 */
export async function clearTerminalBackground(png: Blob, background: string | null): Promise<OffscreenCanvas | undefined> {
  if (!background || !/^#[0-9a-f]{6}$/.test(background)) return undefined;
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(background.slice(i, i + 2), 16));
  const { data } = image;
  // Hot loop over every pixel: kept free of per-pixel closures.
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha === 0) continue;
    if (Math.abs(data[i] / alpha - r) <= 3 && Math.abs(data[i + 1] / alpha - g) <= 3 && Math.abs(data[i + 2] / alpha - b) <= 3) data[i + 3] = 0;
  }
  context.putImageData(image, 0, 0);
  // Drawn directly: a re-encoded PNG decodes several times slower than Kitty's.
  return canvas;
}
