import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LOOPBACK_ADDRESS } from '../loopback';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const getUrlOrSearch =');
const end = source.indexOf('\n  const persistHistory', start);
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
const resolve = new Function('LOOPBACK_ADDRESS', `${code}; return getUrlOrSearch;`)(LOOPBACK_ADDRESS);

test('loopback development addresses open directly over HTTP', () => {
  for (const address of ['localhost', 'localhost:3000', 'localhost:3000/path?q=test', '127.0.0.1:8080', '[::1]:8080', '[::1]', 'LOCALHOST/path#section']) {
    expect(resolve(address)).toEqual({ url: `http://${address}`, title: `Go to http://${address}`, isSearch: false });
  }
});

test('domain navigation and ordinary searches keep their meaning', () => {
  expect(resolve('127.0.0.1.evil.com:80').url).toBe('https://127.0.0.1.evil.com:80');
  expect(resolve('localhost:3000@evil.com').url).not.toStartWith('http://');
  expect(resolve('example.com').url).toBe('https://example.com');
  expect(resolve('https://localhost:3000').url).toBe('https://localhost:3000');
  for (const query of ['localhost tutorial', 'localhostevil', 'localhost:abc', 'localhost:99999']) {
    expect(resolve(query).isSearch).toBe(true);
  }
});
