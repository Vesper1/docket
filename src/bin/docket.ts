#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { runCli } from '../lib/features/cli/run-cli.ts';

/**
 * Replaced by the bundler with a string literal. The vendored engine is one
 * file with no `package.json` beside it, so the version has to travel inside
 * the bundle; running from source still reads the real manifest.
 */
declare const __DOCKET_VERSION__: string | undefined;

const version =
	typeof __DOCKET_VERSION__ === 'string'
		? __DOCKET_VERSION__
		: (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
				version: string;
			}).version;

const outcome = await runCli(process.argv.slice(2), {
	version,
	cwd: process.cwd(),
});

if (outcome.stdout !== '') process.stdout.write(outcome.stdout);
if (outcome.stderr !== '') process.stderr.write(outcome.stderr);

// Set rather than call process.exit, so buffered output is never truncated.
process.exitCode = outcome.exitCode;
