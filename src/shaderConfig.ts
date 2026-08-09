/**
 * Shared holder for the optional content post-process "shader" settings.
 *
 * awrit hands Chromium-rendered bitmaps to the terminal, so there is no GLSL
 * stage we own between Chromium and the terminal. This module drives an
 * opt-in, CPU-based post-process applied to the RGBA bitmap in paint.ts — the
 * practical meaning of "shaders for UX" in a terminal-browser context.
 *
 * It is OFF by default (see config.js `shader.enabled`). Settings here are
 * updated live from loadConfig() whenever config.js changes.
 */

export type ShaderTint = 'none' | 'warm' | 'cool';

export interface ShaderSettings {
  enabled: boolean;
  vignette: number; // 0..1
  contrast: number; // 1.0 = unchanged
  tint: ShaderTint;
  scanline: number; // 0..1
}

const DEFAULT_SHADER_SETTINGS: ShaderSettings = {
  enabled: false,
  vignette: 0.35,
  contrast: 1.0,
  tint: 'none',
  scanline: 0.0,
};

export const shaderSettings: ShaderSettings = { ...DEFAULT_SHADER_SETTINGS };

export function updateShaderSettings(config: Partial<ShaderSettings> | undefined): void {
  Object.assign(shaderSettings, DEFAULT_SHADER_SETTINGS);
  if (!config) return;
  if (typeof config.enabled === 'boolean') shaderSettings.enabled = config.enabled;
  if (typeof config.vignette === 'number') {
    shaderSettings.vignette = Math.min(1, Math.max(0, config.vignette));
  }
  if (typeof config.contrast === 'number') {
    shaderSettings.contrast = Math.max(0.1, config.contrast);
  }
  if (config.tint === 'none' || config.tint === 'warm' || config.tint === 'cool') {
    shaderSettings.tint = config.tint;
  }
  if (typeof config.scanline === 'number') {
    shaderSettings.scanline = Math.min(1, Math.max(0, config.scanline));
  }
}

/**
 * Apply the configured post-process to a bitmap buffer in place.
 * Only runs when shaderSettings.enabled is true. Designed to be cheap enough
 * to run per-frame, but it is still gated behind an explicit opt-in.
 */
export function applyShader(buffer: Buffer, width: number, height: number): void {
  const { enabled, vignette, contrast, tint, scanline } = shaderSettings;
  if (!enabled) return;
  if (vignette <= 0 && contrast === 1 && tint === 'none' && scanline <= 0) return;

  const cx = width / 2;
  const cy = height / 2;
  // Max distance from center to a corner — used to normalize the vignette.
  // Compare against the squared max distance to avoid a sqrt per pixel.
  const maxDistSq = cx * cx + cy * cy || 1;

  // Precompute tint multipliers.
  const tintR = tint === 'warm' ? 1.04 : tint === 'cool' ? 0.97 : 1.0;
  const tintB = tint === 'warm' ? 0.97 : tint === 'cool' ? 1.04 : 1.0;

  // Contrast pivot: contrast c around 128 -> f(v) = (v-128)*c + 128.
  const c = contrast;
  const hasContrast = c !== 1;
  const hasVignette = vignette > 0;

  for (let y = 0; y < height; y++) {
    // Scanline oscillates per row; treat every other row as slightly darker.
    const scanFactor = scanline > 0 ? 1 - scanline * (y % 2 === 0 ? 1 : 0) : 1;
    // Row-constant vignette term (depends only on y) hoisted out of the x-loop.
    let rowVignette = 1;
    if (hasVignette) {
      const dy = y - cy;
      rowVignette = dy * dy;
    }

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // Brightness-based vignette: darken as we move away from center.
      let mult = scanFactor;
      if (hasVignette) {
        const dx = x - cx;
        const distSq = dx * dx + rowVignette;
        // Smooth falloff, strongest at the corners. Squared distance avoids sqrt.
        const v = 1 - vignette * (distSq / maxDistSq);
        mult *= v;
      }

      // Contrast around mid-gray.
      if (hasContrast) {
        // Apply contrast first, then vignette/tint multiplier.
        const r = ((buffer[idx] - 128) * c + 128) * mult * tintR;
        const g = ((buffer[idx + 1] - 128) * c + 128) * mult;
        const b = ((buffer[idx + 2] - 128) * c + 128) * mult * tintB;
        buffer[idx] = r < 0 ? 0 : r > 255 ? 255 : r;
        buffer[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        buffer[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      } else {
        const r = buffer[idx] * mult * tintR;
        const g = buffer[idx + 1] * mult;
        const b = buffer[idx + 2] * mult * tintB;
        buffer[idx] = r < 0 ? 0 : r > 255 ? 255 : r;
        buffer[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        buffer[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
  }
}
