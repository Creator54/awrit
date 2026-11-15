import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('saving one origin keeps zoom saved earlier for other origins', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-zoom-'));
  process.env.XDG_DATA_HOME = data;
  const file = path.join(data, 'awrit', 'zoom-state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ 'https://old.example': 1.5 }));

  const { setZoomFactor, saveZoomState } = await import('./zoom-state');
  setZoomFactor('https://new.example', 2);
  await saveZoomState();

  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    'https://old.example': 1.5,
    'https://new.example': 2,
  });
});
