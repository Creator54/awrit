#!/usr/bin/env python3
"""Linux plain-Electron offscreen window resource control; requires a display.

AWRIT_ELECTRON=/path/to/electron python3 scripts/perf/window-cycle.py
Keeps evidence in a printed temporary directory; does not change GPU/sandbox flags.
"""
import argparse
import json
import os
import pathlib
import re
import signal
import subprocess
import tempfile
import threading


def snapshot(owner, cycle):
    parents = {}
    for process in pathlib.Path('/proc').glob('[0-9]*'):
        try:
            parents[int(process.name)] = int((process / 'stat').read_text().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError):
            continue
    pids = {owner}
    while added := {pid for pid, parent in parents.items() if parent in pids} - pids:
        pids.update(added)
    rows = []
    for pid in sorted(pids):
        process = pathlib.Path('/proc') / str(pid)
        try:
            command = (process / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            descriptors = []
            fds = list((process / 'fd').iterdir())
            for fd in fds:
                try:
                    target = fd.readlink().as_posix()
                    if '/dev/shm/.org.chromium.' in target or 'memfd:shared-memory-region' in target:
                        stat = fd.stat()
                        descriptors.append({'target': target, 'bytes': stat.st_size,
                                            'device': stat.st_dev, 'inode': stat.st_ino})
                except OSError:
                    continue
            memory = {}
            for line in (process / 'smaps_rollup').read_text().splitlines():
                key, _, value = line.partition(':')
                if key in ('Rss', 'Pss'):
                    memory[key + 'KiB'] = int(value.split()[0])
            mappings = sum('.org.chromium.' in line or 'memfd:shared-memory-region' in line
                           for line in (process / 'maps').read_text().splitlines())
            role = re.search(r'--type=([^ ]+)', command)
            rows.append({'pid': pid, 'role': role[1] if role else 'owner',
                         'fds': len(fds),
                         'sharedHandles': descriptors, 'sharedMappings': mappings, **memory})
        except (OSError, ValueError):
            continue  # Child exited while sampling.
    return {'cycle': cycle, 'processes': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--electron', default=os.environ.get('AWRIT_ELECTRON'))
    parser.add_argument('--cycles', type=int, default=60)
    args = parser.parse_args()
    if not args.electron or args.cycles < 1:
        parser.error('provide --electron (or AWRIT_ELECTRON) and a positive --cycles')
    root = pathlib.Path(tempfile.mkdtemp(prefix='awrit-window-cycle-'))
    print(root, flush=True)
    env = dict(os.environ, XDG_CONFIG_HOME=str(root / 'config'),
               AWRIT_SOAK_CYCLES=str(args.cycles))
    with (root / 'electron.log').open('w') as errors, (root / 'samples.jsonl').open('w') as output:
        process = subprocess.Popen([args.electron, str(pathlib.Path(__file__).with_suffix('.cjs').resolve()),
                                    '--user-data-dir=' + str(root / 'profile')],
                                   env=env, stdout=subprocess.PIPE, stderr=errors, text=True,
                                   start_new_session=True)
        timed_out = threading.Event()

        def stop_group():
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

        def expire():
            timed_out.set()
            stop_group()

        # Bound stalled first-paint/teardown runs without disabling sandboxing.
        watchdog = threading.Timer(60 + args.cycles * 2, expire)
        watchdog.start()
        try:
            for line in process.stdout:
                if line.startswith('SAMPLE '):
                    sample = snapshot(process.pid, line.split()[1])
                    output.write(json.dumps(sample) + '\n')
                    output.flush()
                    print(json.dumps({'cycle': sample['cycle'], 'processes': [
                        {key: value for key, value in row.items() if key != 'sharedHandles'} |
                        {'sharedHandles': len(row['sharedHandles']),
                         'uniqueBackingBytes': sum({(item['device'], item['inode']): item['bytes']
                                                    for item in row['sharedHandles']}.values())}
                        for row in sample['processes']]}), flush=True)
            status = process.wait(timeout=15)
            if timed_out.is_set():
                raise TimeoutError('Resource control exceeded its time budget; see ' + str(root))
            if status != 0:
                raise RuntimeError('Electron failed; see ' + str(root / 'electron.log'))
        finally:
            watchdog.cancel()
            if process.poll() is None or timed_out.is_set():
                stop_group()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()


if __name__ == '__main__':
    main()
