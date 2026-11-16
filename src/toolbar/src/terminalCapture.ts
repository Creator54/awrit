/**
 * Make the terminal's default background see-through so the review follows
 * Kitty's own background and opacity. Kitty's screenshot stores that
 * background pre-multiplied by the opacity, so un-multiply before comparing.
 */
export async function clearTerminalBackground(png: Blob, background: string | null): Promise<Blob> {
  if (!background || !/^#[0-9a-f]{6}$/.test(background)) return png;
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return png;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const target = [1, 3, 5].map(i => Number.parseInt(background.slice(i, i + 2), 16));
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha === 0) continue;
    if ([0, 1, 2].every(c => Math.abs(data[i + c] / alpha - target[c]) <= 3)) data[i + 3] = 0;
  }
  context.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
