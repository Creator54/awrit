import { runPresentationCli } from './cli';

runPresentationCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 2;
  })
  .catch((error: unknown) => {
    process.stderr.write(`awrit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
