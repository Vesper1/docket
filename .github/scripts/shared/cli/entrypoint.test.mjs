import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createWorkspaceFixture } from '../testing/workspace-fixture.mjs';

import { isEntrypoint } from './entrypoint.mjs';

const entrypointUrl = pathToFileURL(
	join(import.meta.dirname, 'entrypoint.mjs'),
).href;

const runnerSource = (body) => `
import { runAsEntrypoint } from '${entrypointUrl}';

runAsEntrypoint(import.meta.url, () => { ${body} });
`;

test('runs main when invoked through a symlinked directory', () => {
	const fixture = createWorkspaceFixture({
		files: [['scripts/run.mjs', runnerSource("process.stdout.write('ran');")]],
	});

	try {
		symlinkSync(
			join(fixture.workspace, 'scripts'),
			join(fixture.root, 'linked-scripts'),
		);

		for (const directory of [
			join(fixture.workspace, 'scripts'),
			join(fixture.root, 'linked-scripts'),
		]) {
			const result = spawnSync(process.execPath, [join(directory, 'run.mjs')], {
				encoding: 'utf8',
			});

			assert.equal(result.stdout, 'ran', `not run through ${directory}`);
		}
	} finally {
		fixture.remove();
	}
});

test('reports a thrown error as a failing exit code', () => {
	const fixture = createWorkspaceFixture({
		files: [
			[
				'run.mjs',
				runnerSource("throw new TypeError('CODE_FILES is required');"),
			],
		],
	});

	try {
		const result = spawnSync(
			process.execPath,
			[join(fixture.workspace, 'run.mjs')],
			{ encoding: 'utf8' },
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /CODE_FILES is required/);
	} finally {
		fixture.remove();
	}
});

test('ignores modules that are not the process entry point', () => {
	assert.equal(isEntrypoint(import.meta.url, import.meta.filename), true);
	assert.equal(
		isEntrypoint(import.meta.url, join(import.meta.dirname, 'missing.mjs')),
		false,
	);
});

test('stays silent when a runner is imported instead of executed', () => {
	const fixture = createWorkspaceFixture({
		files: [['run.mjs', runnerSource("process.stdout.write('ran');")]],
	});

	try {
		// `node --eval` leaves `process.argv[1]` undefined, the same shape as any
		// other module importing a runner for its exports.
		const result = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'--eval',
				`await import(${JSON.stringify(pathToFileURL(join(fixture.workspace, 'run.mjs')).href)});`,
			],
			{ encoding: 'utf8' },
		);

		assert.equal(result.status, 0);
		assert.equal(result.stdout, '');
	} finally {
		fixture.remove();
	}
});
