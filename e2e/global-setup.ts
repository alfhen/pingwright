import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function build(): void {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.ts', import.meta.url))], { cwd: root, stdio: 'inherit' });
}
