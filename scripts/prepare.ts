import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

await import('./build.ts');

// For `npm i -g <git url>`, npm 10 runs the clone's install in global mode, which links the temporary clone into
// the global prefix. The clone is deleted afterwards and the real install writes through the dangling link.
// Removing the link here lets the real install create a normal copy.
if (process.env.npm_config_global === 'true' && process.env.npm_config_prefix) {
  const prefix = process.env.npm_config_prefix;
  const link = join(prefix, 'lib', 'node_modules', 'pingwright');
  try {
    if (lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(process.cwd())) {
      unlinkSync(link);
      unlinkSync(join(prefix, 'bin', 'pingwright'));
    }
  } catch {
    // Nothing was linked.
  }
}
