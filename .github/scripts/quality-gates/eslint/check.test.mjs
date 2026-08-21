import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceFixture } from '../../shared/testing/workspace-fixture.mjs';

import { main, runEslint } from './check.mjs';

test('runs the workspace ESLint without a shell and returns its status', () => {
	const fixture = createWorkspaceFixture({
		files: [['src/example.ts', 'export {};\n']],
	});
	const invocations = [];

	try {
		const status = runEslint(['src/example.ts'], {
			spawn: (...arguments_) => {
				invocations.push(arguments_);
				return { status: 1 };
			},
			workspace: fixture.workspace,
		});

		assert.equal(status, 1);
		assert.equal(invocations.length, 1);

		const [command, commandArguments, options] = invocations[0];

		assert.equal(command, process.execPath);
		assert.equal(
			commandArguments[0],
			join(fixture.workspace, 'node_modules', 'eslint', 'bin', 'eslint.js'),
		);
		assert.equal(
			commandArguments.at(-1),
			join(fixture.workspace, 'src', 'example.ts'),
		);
		assert.equal(options.cwd, fixture.workspace);
		assert.equal(options.shell, false);
	} finally {
		fixture.remove();
	}
});

test('reads the changed files from JS_TS_FILES', () => {
	assert.throws(() => main({}), /JS_TS_FILES is required/);
	assert.throws(
		() => main({ JS_TS_FILES: '["../outside.ts"]' }),
		/JS_TS_FILES path escapes the workspace/,
	);
});

test('resolves the checkout from GITHUB_WORKSPACE', () => {
	const fixture = createWorkspaceFixture({
		files: [['src/example.ts', 'export {};\n']],
	});
	let commandArguments;

	try {
		main(
			{
				GITHUB_WORKSPACE: fixture.workspace,
				JS_TS_FILES: '["src/example.ts"]',
			},
			{
				spawn: (...arguments_) => {
					commandArguments = arguments_[1];
					return { status: 0 };
				},
			},
		);

		assert.equal(
			commandArguments.at(-1),
			join(fixture.workspace, 'src', 'example.ts'),
		);
	} finally {
		fixture.remove();
	}
});
