import { describe, expect, test } from 'bun:test';
import { sshArgv, sshCommandArgv, sshScriptArgv, validateAlias } from './sshCommand';

describe('validateAlias', () => {
  test('accepts plain ssh config aliases', () => {
    expect(validateAlias('phoenix')).toBe('phoenix');
    expect(validateAlias('build.host-2_@pool')).toBe('build.host-2_@pool');
  });
  test('accepts aliases at the length limit', () => {
    expect(validateAlias(`a${'b'.repeat(252)}`)).toHaveLength(253);
  });
  test('rejects option-like, spaced, control and empty aliases', () => {
    for (const alias of ['-oProxyCommand=x', 'a b', 'a\nb', '', ' phoenix', 'phoenix ', 'ph\t']) {
      expect(() => validateAlias(alias)).toThrow();
    }
    expect(() => validateAlias(`a${'b'.repeat(253)}`)).toThrow();
  });
});

describe('sshArgv', () => {
  test('builds the media argv from the plan', () => {
    expect(sshArgv('phoenix', 'media', '/r/awrit')).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'Compression=no',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ServerAliveInterval=2',
      '-o',
      'ServerAliveCountMax=3',
      '--',
      'phoenix',
      '/r/awrit',
      'remote-bridge',
      '--channel',
      'media',
    ]);
  });
  test('passes the channel through', () => {
    for (const channel of ['control', 'media', 'bulk'] as const) {
      expect(sshArgv('phoenix', channel, '/r/awrit').slice(-2)).toEqual(['--channel', channel]);
    }
  });
  test('keeps the runtime path as one argv item', () => {
    const argv = sshArgv('phoenix', 'control', '/r/awrit');
    expect(argv[argv.indexOf('phoenix') + 1]).toBe('/r/awrit');
  });
  test('rejects unsafe runtime paths', () => {
    for (const path of ['', 'r/awrit', '/r/../awrit', '/r awrit', '/r\tawrit', '/r\nawrit']) {
      expect(() => sshArgv('phoenix', 'media', path)).toThrow();
    }
  });
  test('rejects shell metacharacters the remote shell would interpret', () => {
    for (const path of [
      '/r/a;id',
      '/r/$(id)',
      '/r/a`id`',
      '/r/a|id',
      '/r/a&id',
      '/r/a>f',
      '/r/a*b',
      "/r/a'q'",
      '/r/a\\b',
      '/r/a#c',
      '/r/a~b',
    ]) {
      expect(() => sshArgv('phoenix', 'media', path)).toThrow();
    }
  });
  test('rejects an invalid alias before building argv', () => {
    expect(() => sshArgv('-oProxyCommand=x', 'media', '/r/awrit')).toThrow();
  });
  test('adds only the forwarding options to the control lane', () => {
    const base = sshArgv('phoenix', 'control', '/r/awrit');
    const at = base.indexOf('--');
    expect(sshArgv('phoenix', 'control', '/r/awrit', { localPort: 3000, remotePort: 0 })).toEqual([
      ...base.slice(0, at),
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'LogLevel=INFO',
      '-R',
      '127.0.0.1:0:127.0.0.1:3000',
      ...base.slice(at),
    ]);
  });
  test('keeps an already allocated remote port on a reattach', () => {
    const argv = sshArgv('phoenix', 'control', '/r/awrit', { localPort: 3000, remotePort: 41000 });
    expect(argv[argv.indexOf('-R') + 1]).toBe('127.0.0.1:41000:127.0.0.1:3000');
  });
  test('rejects forwarding on other lanes and invalid ports', () => {
    for (const channel of ['media', 'bulk'] as const)
      expect(() =>
        sshArgv('phoenix', channel, '/r/awrit', { localPort: 3000, remotePort: 0 }),
      ).toThrow();
    for (const forward of [
      { localPort: 0, remotePort: 0 },
      { localPort: 65536, remotePort: 0 },
      { localPort: 3000, remotePort: 65536 },
      { localPort: 1.5, remotePort: 0 },
    ])
      expect(() => sshArgv('phoenix', 'control', '/r/awrit', forward)).toThrow();
  });
});

describe('sshScriptArgv', () => {
  test('feeds a fixed script to sh -s with validated positional args', () => {
    const argv = sshScriptArgv('phoenix', ['2.0.5', '/home/you/.cache/awrit/src.abc']);
    expect(argv.slice(argv.indexOf('phoenix'))).toEqual([
      'phoenix',
      'sh',
      '-s',
      '--',
      '2.0.5',
      '/home/you/.cache/awrit/src.abc',
    ]);
    expect(argv).toContain('BatchMode=yes');
    expect(sshScriptArgv('phoenix')).toContain('sh');
  });
  test('rejects args the remote shell would split or interpret', () => {
    for (const arg of ['a b', '2.0.5;id', '$(id)', '../x y', '']) {
      expect(() => sshScriptArgv('phoenix', [arg])).toThrow();
    }
  });
});

describe('sshCommandArgv', () => {
  test('passes a plain command through', () => {
    expect(
      sshCommandArgv('phoenix', ['tar', '-x', '-C', '/home/you/.cache/awrit/src.abc']).slice(-5),
    ).toEqual(['phoenix', 'tar', '-x', '-C', '/home/you/.cache/awrit/src.abc']);
  });
  test('rejects empty or unsafe commands', () => {
    expect(() => sshCommandArgv('phoenix', [])).toThrow();
    expect(() => sshCommandArgv('phoenix', ['sh', '-c', 'id; rm -rf x'])).toThrow();
    expect(() => sshCommandArgv('phoenix', ['tar', '-x', '-C', '/a b'])).toThrow();
  });
});
