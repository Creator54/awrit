import { beforeEach, describe, expect, test } from 'bun:test';
import { applyShader, shaderSettings, updateShaderSettings } from './shaderConfig';

describe('shader settings', () => {
  beforeEach(() => {
    updateShaderSettings({
      enabled: false,
      vignette: 0.35,
      contrast: 1,
      tint: 'none',
      scanline: 0,
    });
  });

  test('clamps external configuration values', () => {
    updateShaderSettings({ enabled: true, vignette: 2, contrast: 0, scanline: -1 });

    expect(shaderSettings).toMatchObject({
      enabled: true,
      vignette: 1,
      contrast: 0.1,
      scanline: 0,
    });
  });

  test('does not touch pixels while disabled', () => {
    const pixels = Buffer.from([100, 120, 140, 255]);
    applyShader(pixels, 1, 1);
    expect([...pixels]).toEqual([100, 120, 140, 255]);
  });

  test('resets omitted live configuration to defaults', () => {
    updateShaderSettings({ enabled: true, tint: 'warm' });
    updateShaderSettings(undefined);

    expect(shaderSettings).toMatchObject({ enabled: false, tint: 'none' });
  });
});
