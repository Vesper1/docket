#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { runCli } from '../lib/features/cli/cli.ts';

const packageJson = new URL('../../package.json', import.meta.url);
const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };

const outcome = await runCli(process.argv.slice(2), {
	version,
	cwd: process.cwd(),
	env: process.env,
	now: () => new Date(),
});

if (outcome.stdout !== '') process.stdout.write(outcome.stdout);
if (outcome.stderr !== '') process.stderr.write(outcome.stderr);

// Set rather than call process.exit, so buffered output is never truncated.
process.exitCode = outcome.exitCode;
