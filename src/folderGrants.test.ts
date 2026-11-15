import { expect, test } from 'bun:test';
import { clearGrants, grantFolder, permitsFileSystem } from './folderGrants';

const read = (filePath: string) => ({ fileAccessType: 'readable', filePath });

test('the page origin may read files inside the folder it was given', () => {
  grantFolder(7, 'https://blender.example/app?x=1', '/home/u/blends');
  expect(permitsFileSystem('https://blender.example/', read('/home/u/blends/scene.blend'))).toBe(true);
  expect(permitsFileSystem('https://blender.example', read('/home/u/blends'))).toBe(true);
  clearGrants(7);
});

test('nothing outside the folder, no writes, no other origin', () => {
  grantFolder(8, 'https://blender.example/', '/home/u/blends');
  expect(permitsFileSystem('https://blender.example/', read('/home/u/other.txt'))).toBe(false);
  expect(permitsFileSystem('https://blender.example/', read('/home/u/blends-evil/x'))).toBe(false);
  expect(permitsFileSystem('https://blender.example/', { fileAccessType: 'writable', filePath: '/home/u/blends/a' })).toBe(false);
  expect(permitsFileSystem('https://evil.example/', read('/home/u/blends/a'))).toBe(false);
  expect(permitsFileSystem('https://blender.example/', {})).toBe(false);
  clearGrants(8);
});

test('a navigation removes access, and opaque origins never get any', () => {
  grantFolder(9, 'https://blender.example/', '/home/u/blends');
  clearGrants(9);
  expect(permitsFileSystem('https://blender.example/', read('/home/u/blends/a'))).toBe(false);
  grantFolder(10, 'data:text/html,x', '/home/u/blends');
  expect(permitsFileSystem('null', read('/home/u/blends/a'))).toBe(false);
});
