import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

// Built from uiDumper/Dumper.java by uiDumper/build.sh.
const HELPER_JAR_BASE64 =
  'UEsDBBQAAAAIAAAAITiAJqPpygkAAOwSAAALAAAAY2xhc3Nlcy5kZXh1mF1sHNUVx8/Mfnp37R1/xlknzmYNxiS213ZwcGKTkNhOMWw+iB0DNlBmZ+56J1nPrGdn/SFURKsqSBUqrYraqkKVqtKHtkiIikqVWtRW8IQAUcRD1fLQSJXgIQKpoq0qobb/e+fuemLA9m/PueecO/fce8/c8Y7JthNjx6boF8f73+s+/Z0fvZ1fO/fEfw9mPn5n6s3Q9Q92bnYQVYloe/kuaP7PELQnybcfBI+qRH2Q70LGILvCRMOQBUgF8qUIUbaV6C3I/iR0MAjuBMMgD2bAA+BhYAAXfBN8F/wY/Ar8AfwJ3ACfgH+A/wBKYVzQCjpBH+gHh0EeTIF5cB6sgsfBNWCDDeCBp8A3wHXwLfAc+B54CfwNfAZ6MIcxUAAGeBr8ELwM/gj+Cj4GkTaifeAoOA1WgA2eA78Er4DfgN+C34M3wJvgbXAD/Ask00Qa6AIHwG1gFZjAAlWwA54F3wc/Ay+D18D74Cb4N2jTkAsYAqfBLHgAPAwMUAVPguvgB+Cn4BXwGngHvA/+Aj4EN8E/wf9AtJ0oDXpAFtwOhsEkOAvuAzlszQC4HRwlvyZGwCjIgzEwDibAMXAXmATHwd1gCpwAJ8E0mAH3gFPgNDgLzoGvgPvAAvljNn4GAUqQnk1g/SDbpJ3r6UYtS/15xNwBibTpBeh3QvKCfzHhx3D9JXmdzkBfrr8q47n+u4Q/bpccd0jq/PpHpP6GtPeAt2TffeD9hD+nXnn9Wal/APuc1P+e2LXfDOifQp+X+mcBezy5q2sB/flATG/SX8f9ctwQOC/lNSlrUtaJ3+MxssVapeleyG5qoa9CqqRRv5AtdEnI/VQRsoN2RH/fH0bPRSEVWpJ7dEVIlR6S8mEpHxUyTo8LmSFdyqKUhpSmlEzKkpRrUpaltKS8ChnFDvQLGRdnWRw7yNsJ7BKXKczMlxo9KOQ+coTsFbINPTxRP2G6LGQbPSJkmlbE+kRoS9SOP+8OrMCyqJMEuaIWeoW9i5JUEDIlZauQPVjndVEbUXpCrKN/njYO4sN8T9H4pL2xb4rYo7mEf8+cUCOUQad21dX60TulZtA3o3STPXY7qQpv41fZF2hn0e4JtLFWSm+graLdGWiH0O5qtttVhRSR4/0Jf1+r2oBYqSSsfL8vwP5rWDKJC7ShHcJKpBIdNKBkyM5ibEopA2of9COYXUrJqBdpIATf2GE6EkqpAyH4xo5SRyijPhb0JEQveDJqKmFrt/HrovdqM+ZwKKXk1CjlQgkqhqNUze5H/VezPTh9cqEU5cJxKkbCsPSiJjORM1S9N0OzlzLhDWRzELG21ofZ2to+vpLhqfASyXHCmcg2dQwOrKEq4xE6H48J2bEfWgsfeymWCg+wPuqJmrSRzdEmpaLnoxG0PwoF2i08/xcjQ2prOBfuQg4Hkc0gshmI+HP7SSQVOYQcpyIRXCeE+z3DPdkhxNjZA8gxE1ZuyXbo5/zM4/fKUb4vivZtRdS7KmqJYS+yMNhaN/YmgfO2T8mhV1XjO2dnI2L3D4kRurGetpaAJaVuaIqoJm73dylNDd3GIfPFMfFATPxLYhKBmJYviYkGYlI8b/julL5YwNe6x9cS8LXt8SUDvvQeXyrg0/b4tICvc4+vNeBr3+NrC/g69vjaA76uPb5I03dZ5Tt9h7Tv37WHQsI+zu2hB4R9XNjVpr0ZK3b5DlRGCvt8v4jVcELYWoyPq0xqPM8o3wdlSvFr7kH6Mw6hoU8y4QMifh739hGF2lZQVTgPoVnvvXfj9ddvPHNVGUlvP7Oy8mo/9aHa2qxnlNvS/O9A4G8wrfSllc70KsmzrSE7pVTkudeB/zC53idtbdLehl9FPru4zEh7JzRFPrNUceZ3iXZMxrVIXxI9G2O1Bs5XLg/wfsr8hTlSEqS0Em6OZC5bdOq2Wbsnt0qtuaxRZsY1vVhh9wifaDITjRY0KnoNcSKsYjXDNDQd22O2N2KymuF3ZDb3mn6j5Bj1mmh05LIVx14bCfZP5bJVXHjLcXlEOpd1Wc2puwYbsbihLZetGa5TqeyG11iFGZ64oDJIkcGB8bFpIY5xoa9Xpyk8uObxzwo+o4MbdQdSGSZlhlIz+bLFXN01yjunKDaTtx2TnaLkTMAanbFsyzuFWO7Memzb42Mhaq6+XmXu6FV9UydlgVBkSoHiBd88TWphAdwPChQq4EMtrNC+gm6brmOZ+TVXr5Yto5a/jPynaaLp2LTYVl43DFarWUWrYnk7+TPB1gWksWCXnGnKFEy9smldy+u27Xi6Zzl2fqnsOlu1aeot8LzylpM/Wy+VmMvMy0w3eV67nnNWhc1hm1yr6jkuv17Qc7HuVeveoucyfX2aupu+BTtg7vsic2Oknqbzy651ybXspllrmvekWtHttfxsWXcX2Uad2Qabpvagh9di86rCNL9tsCpfj+ZVhbmAepumjoDlYvGqWP6gDflYPG7/52xn61ZFJHZL+E7NY0j/UMDmshIvy/ysY9c8t24El/eWgPPMKzsmqnPpkUvzFLmydG5kipRlUpdRNMsomvByYaVAygp1rH5+yp2rXzCVW4yNuYQey50i9bFViurVKrNNihYdz3PWadJw1kdl6Y3WLb0Oo450Rw3HZaNXrDO+AUu5WGaVykMu7+9SDLe5jeEohPqhSKlSr5UpVnLcC/o6o/Y15p0VR8mCvWi4jNkUh2m2jOWj1oY2iwjPd/DpUKqhiWt085Z/ljRqFElQD8xzDMcPKjqwutQCu7+Youdlx/EW7DOGZ22yhyzbdLYoBvMS7l5KQwlOTHRYxl23gHvEP25EBqplU9SyN51rjJJWbbZxHFKLbDBT2BvnF7fP+2cdV8/5Jx2lrRqvu92whFW7JA85Slm1xeaJxj2L8jzj3ZYt3PMVtuRcqWHJwxVW8ii8riOtpI1sMXkdNwOFnLpHsSq/lSpYaNxMZsGyGUW4tkMxl1UrusHb1loZC+45flVQyHOqFNnUK3VGMSEulii5pVveOcddMJFQeEuvXKMXlKeempt6MlfUMWfbzJ3MmWw7N5xD6VStiljDkXWcSsJRrK/BVdZrI+KBUauv13InS3qlxoZz65Y9olet3MmJ48O5WlkfGUeXEnIzS3eNF4vmxFRx8vgxc5ydYGMnjMnS3RPm3cakoU+emDIncdVN5tYwGDpNjU6MTuAZs5n7GqkRZfOA0quJf8q//nT43ZQSfyuptHwE+WlaPu8+lN8jgs9i/uyM44Go7bFz2XgHxGMa74FCtPsuKEy774MitPtOKEq774WUrB/H3w2FpM6/vyia/xzm36HVrD8Wf3cUzgZylTr//hPSfJ3nGpV2/t2IpJ2/s/o/UEsBAhQDFAAAAAgAAAAhOIAmo+nKCQAA7BIAAAsAAAAAAAAAAAAAAIABAAAAAGNsYXNzZXMuZGV4UEsFBgAAAAABAAEAOQAAAPMJAAAAAA==';

const HELPER_PATH = '/data/local/tmp/awrit-ui.jar';
const END = '\u0001END';
const START_TIMEOUT_MS = 5000;
const DUMP_TIMEOUT_MS = 5000;
// Android allows one UiAutomation connection at a time; let go of it when nobody is looking.
const IDLE_MS = 30_000;

/** Stock `uiautomator dump`: a fresh JVM per call, about 2 s. */
export async function stockDump(
  adbBin: string,
  device: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await executeFile(
      adbBin,
      [
        '-s',
        device,
        'shell',
        // rm first so a failed dump cannot return the previous screen; uiautomator can exit 0
        // without writing the file ("could not get idle state"), so report its output instead.
        'f=/data/local/tmp/awrit-ui.xml; rm -f $f; out=$(uiautomator dump --compressed $f 2>&1); [ -s $f ] && cat $f || { echo "$out" >&2; exit 1; }',
      ],
      { timeout: 12_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, signal },
    );
    return stdout;
  } catch (error) {
    const stderr = Reflect.get(Object(error), 'stderr');
    throw new Error((typeof stderr === 'string' && stderr.trim()) || String(error));
  }
}

interface Helper {
  proc: ChildProcess;
  /** Resolves with the XML of the next dump. */
  request(): Promise<string>;
}

function startHelper(adbBin: string, device: string, onExit: () => void): Promise<Helper> {
  // The jar is written by the same shell that runs it, so there is no separate push step.
  const script = `echo ${HELPER_JAR_BASE64} | base64 -d > ${HELPER_PATH} && CLASSPATH=${HELPER_PATH}:/system/framework/uiautomator.jar exec app_process /system/bin Dumper`;
  const proc = spawn(adbBin, ['-s', device, 'shell', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  let waiting: { resolve: (xml: string) => void; reject: (error: Error) => void } | null = null;
  let ready: (() => void) | null = null;
  const fail = (error: Error) => {
    const pending = waiting;
    waiting = null;
    pending?.reject(error);
  };
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    if (ready) {
      const index = buffer.indexOf('ready\n');
      if (index === -1) return;
      buffer = buffer.slice(index + 6);
      ready();
      ready = null;
    }
    const end = buffer.indexOf(`${END}\n`);
    if (end === -1 || !waiting) return;
    const xml = buffer.slice(0, end);
    buffer = buffer.slice(end + END.length + 1);
    const pending = waiting;
    waiting = null;
    pending.resolve(xml);
  });
  proc.on('close', () => {
    fail(new Error('UI helper exited'));
    onExit();
  });
  proc.on('error', () => proc.emit('close'));

  return new Promise<Helper>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('UI helper did not start'));
    }, START_TIMEOUT_MS);
    ready = () => {
      clearTimeout(timer);
      resolve({
        proc,
        request: () =>
          new Promise<string>((resolveDump, rejectDump) => {
            const dumpTimer = setTimeout(() => {
              fail(new Error('UI helper timed out'));
              proc.kill('SIGKILL');
            }, DUMP_TIMEOUT_MS);
            waiting = {
              resolve: (xml) => {
                clearTimeout(dumpTimer);
                resolveDump(xml);
              },
              reject: (error) => {
                clearTimeout(dumpTimer);
                rejectDump(error);
              },
            };
            proc.stdin?.write('\n');
          }),
      });
    };
    proc.on('close', () => reject(new Error('UI helper exited')));
  });
}

export interface UiDumper {
  dump(): Promise<string>;
  close(): void;
}

/**
 * Reads the screen's accessibility tree. A resident helper on the device answers in about
 * 100 ms; if it cannot start or fails, this falls back to the stock `uiautomator dump`.
 * Calls are serialized because the device has one UiAutomation connection.
 */
export function createUiDumper(adbBin: string, device: string, signal: AbortSignal): UiDumper {
  let helper: Promise<Helper> | null = null;
  let helperBroken = false;
  let helperFailures = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const stopHelper = () => {
    if (idle) clearTimeout(idle);
    idle = null;
    const current = helper;
    helper = null;
    void current?.then(
      (h) => h.proc.kill('SIGKILL'),
      () => undefined,
    );
  };

  async function run(): Promise<string> {
    if (!helperBroken) {
      try {
        helper ??= startHelper(adbBin, device, () => {
          helper = null;
        });
        const xml = await (await helper).request();
        helperFailures = 0;
        if (idle) clearTimeout(idle);
        idle = setTimeout(stopHelper, IDLE_MS);
        idle.unref();
        return xml;
      } catch {
        // Drop this helper and answer with the stock dump. Two failures in a row mean the
        // device cannot run the helper, so stop trying.
        helperFailures += 1;
        helperBroken = helperFailures >= 2;
        stopHelper();
      }
    }
    return stockDump(adbBin, device, signal);
  }

  return {
    dump() {
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
    close: stopHelper,
  };
}
