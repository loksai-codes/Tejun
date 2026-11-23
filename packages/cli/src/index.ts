// Entry point for the `tejun` command.

import { runCli } from "./main.js";

const result = runCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
