import { main } from './main.ts';

process.stderr.write('pingwright is now tagreeve; this alias goes in 0.5.0\n');
process.exitCode = await main(process.argv.slice(2));
