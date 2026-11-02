#!/usr/bin/env node
import {
  main
} from "./chunk-XDYUCYGC.js";

// packages/cli/src/alias-bin.ts
process.stderr.write("pingwright is now tagreeve; this alias goes in 0.5.0\n");
process.exitCode = await main(process.argv.slice(2));
