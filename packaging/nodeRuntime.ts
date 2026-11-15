import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Official Node distributions have a self-contained executable. Headers, package
// managers and documentation are build-time tools, not application dependencies.
export function copyNodeRuntime(source: string, destination: string): void {
  mkdirSync(join(destination, 'bin'), { recursive: true });
  cpSync(join(source, 'bin/node'), join(destination, 'bin/node'), { dereference: true });
  cpSync(join(source, 'LICENSE'), join(destination, 'LICENSE'));
}
