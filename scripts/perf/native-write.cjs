// Linux diagnostic: compare fresh shm zero-fill with BGRA conversion.
// Usage: node scripts/perf/native-write.cjs /path/to/awrit-native-rs
const { resolve } = require('node:path');
const { unlinkSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
if (process.platform !== 'linux' || !process.argv[2]) {
  throw new Error('Usage (Linux): node scripts/perf/native-write.cjs NATIVE_MODULE_DIR');
}
const { ShmGraphicBuffer } = require(resolve(process.argv[2]));
const width = 1400;
const height = 900;
const bytes = width * height * 4;
const bitmap = Buffer.alloc(bytes, 127);
for (const mode of ['empty', 'convert']) {
  const buffer = new ShmGraphicBuffer(bytes);
  const times = [];
  const before = process.resourceUsage();
  for (let i = 0; i < 120; i++) {
    const previousName = buffer.nameBase64;
    try {
      const start = performance.now();
      if (mode === 'empty') buffer.writeEmpty();
      else buffer.write(bitmap, width);
      times.push(performance.now() - start);
    } finally {
      // No terminal consumes these transfers. Remove only this buffer's fresh
      // object, outside the timing, as Kitty would after reading it.
      const encoded = buffer.nameBase64;
      if (encoded !== previousName) {
        const name = Buffer.from(encoded, 'base64').toString();
        if (!/^\/[^/]+$/.test(name)) throw new Error('Unexpected shared-memory name');
        unlinkSync(`/dev/shm${name}`);
      }
    }
  }
  const after = process.resourceUsage();
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode, bytes, iterations: times.length, p50_ms: times[60], p95_ms: times[114],
    minor_faults: after.minorPageFault - before.minorPageFault,
    user_ms: (after.userCPUTime - before.userCPUTime) / 1000,
    system_ms: (after.systemCPUTime - before.systemCPUTime) / 1000,
    // CPU/fault totals include unlink and JS overhead; write latency does not.
  }));
}
