#!/usr/bin/env node
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: console.log,
  err: console.error,
});
