import { expect, test } from 'bun:test';
import { downloadsFolder, uniqueDownloadPath } from './downloads';

test('uses ~/Downloads when Electron falls back to home', () => {
  expect(downloadsFolder('/home/u', '/home/u')).toBe('/home/u/Downloads');
  expect(downloadsFolder('/home/u/Dl', '/home/u')).toBe('/home/u/Dl');
});

test('never overwrites an existing download', () => {
  const taken = new Set(['/d/scene.blend', '/d/scene (1).blend']);
  expect(uniqueDownloadPath('/d', 'scene.blend', p => taken.has(p))).toBe('/d/scene (2).blend');
  expect(uniqueDownloadPath('/d', 'new.txt', p => taken.has(p))).toBe('/d/new.txt');
});

test('drops directory parts from the suggested name', () => {
  expect(uniqueDownloadPath('/d', '../../etc/passwd', () => false)).toBe('/d/passwd');
  expect(uniqueDownloadPath('/d', '', () => false)).toBe('/d/download');
});
