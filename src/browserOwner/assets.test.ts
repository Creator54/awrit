import { expect, test } from 'bun:test';
import { ownerAssets } from './assets';

test('owner assets resolve from the runtime bundle, not cwd or build source paths', () => {
  expect(ownerAssets('/relocated/lib/awrit/dist/browserOwner/main.js')).toEqual({
    directory: '/relocated/lib/awrit/dist',
    config: '/relocated/lib/awrit/config.js',
  });
});
