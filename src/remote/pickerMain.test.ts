import { expect, test } from 'bun:test';
import vm from 'node:vm';

for (const answer of ['cancel-picker', 'cancel-confirmation', 'upload'])
  test(`isolated picker requires explicit confirmation: ${answer}`, async () => {
    const built = await Bun.build({
      entrypoints: [new URL('./pickerMain.ts', import.meta.url).pathname],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    const source = await built.outputs[0]?.text();
    if (!source) throw Error('No picker build');
    const calls: Record<string, unknown>[] = [];
    const output: string[] = [];
    let exited: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const electron = {
      app: { on: () => {}, whenReady: () => Promise.resolve(), exit: () => exited() },
      dialog: {
        showOpenDialog: async (options: Record<string, unknown>) => {
          calls.push(options);
          return {
            canceled: answer === 'cancel-picker',
            filePaths: answer === 'cancel-picker' ? [] : ['/local/chosen.txt'],
          };
        },
        showMessageBox: async (options: Record<string, unknown>) => {
          calls.push(options);
          return { response: answer === 'upload' ? 1 : 0 };
        },
      },
    };
    vm.runInNewContext(source, {
      exports: {},
      require: (name: string) => (name === 'electron' ? electron : require(name)),
      console,
      process: {
        argv: ['electron', 'picker.js', 'phoenix'],
        on: () => {},
        stdout: {
          write: (text: string, callback: () => void) => {
            output.push(text);
            callback();
          },
        },
      },
    });
    await done;
    expect(calls[0]?.title).toContain('phoenix');
    expect(calls).toHaveLength(answer === 'cancel-picker' ? 1 : 2);
    if (answer !== 'cancel-picker') {
      expect(calls[1]?.defaultId).toBe(0);
      expect(calls[1]?.message).toContain('phoenix');
    }
    expect(output).toEqual(
      answer === 'upload' ? [`${JSON.stringify({ file: '/local/chosen.txt' })}\n`] : [],
    );
  });
