const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ShmGraphicBuffer } = require(process.argv[2] || '../index.js');

// Kitty consumes t=s transfers by unlinking their names. Exercise the same
// buffer again after consumption, including a partial update of a full image.
const width = 4;
const height = 3;
const size = width * height * 4;
const graphic = new ShmGraphicBuffer(size);
const names = new Set();
const currentName = () => {
  const name = '/dev/shm' + Buffer.from(graphic.nameBase64, 'base64').toString();
  names.add(name);
  return name;
};
const first = Buffer.alloc(size);
const second = Buffer.alloc(size);
for (let pixel = 0; pixel < width * height; pixel++) {
  first.set([pixel, 20, 30, 255], pixel * 4);
  second.set([40, 50, 60, 255], pixel * 4);
}

try {
  graphic.write(first, width);
  const original = fs.readFileSync(currentName());
  const pending = currentName();
  graphic.write(second, width);
  assert.notEqual(currentName(), pending, 'pending transfers must have distinct names');
  assert.deepEqual(fs.readFileSync(pending), original, 'a pending transfer must remain intact');
  fs.unlinkSync(pending);
  fs.unlinkSync(currentName());
  graphic.write(second, width);
  assert(fs.existsSync(currentName()), 'a consumed image must have a new named transfer');
  assert.deepEqual(fs.readFileSync(currentName()).subarray(0, 4), Buffer.from([60, 50, 40, 255]));

  graphic.write(first, width);
  fs.unlinkSync(currentName());
  const rect = { x: 1, y: 1, width: 2, height: 1 };
  graphic.write(second, width, rect);
  const updated = fs.readFileSync(currentName());
  for (let pixel = 0; pixel < width * height; pixel++) {
    const changed = pixel === 5 || pixel === 6;
    assert.deepEqual(
      updated.subarray(pixel * 4, pixel * 4 + 4),
      changed ? Buffer.from([60, 50, 40, 255]) : original.subarray(pixel * 4, pixel * 4 + 4),
      'partial updates must preserve pixels outside the dirty rectangle',
    );
  }

  const pendingPartial = currentName();
  graphic.write(first, width, { x: 0, y: 0, width: 1, height: 1 });
  const again = fs.readFileSync(currentName());
  assert.deepEqual(again.subarray(0, 4), original.subarray(0, 4));
  assert.deepEqual(again.subarray(4), updated.subarray(4));
  assert.deepEqual(fs.readFileSync(pendingPartial), updated);

  graphic.writeEmpty();
  assert(fs.existsSync(currentName()), 'empty transfers must also recreate consumed names');
  assert.deepEqual(fs.readFileSync(currentName()), Buffer.alloc(size));
  console.log('shared-memory transfer reuse passed');
} finally {
  for (const name of names) if (fs.existsSync(name)) fs.unlinkSync(name);
}
