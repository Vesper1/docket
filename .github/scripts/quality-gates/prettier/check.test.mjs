import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceFixture } from '../../shared/testing/workspace-fixture.mjs';
import { main, runPrettier } from './check.mjs';

test('runs the workspace Prettier without a shell and returns its status', () => {
	const fixture = createWorkspaceFixture({
		files: [['src/example.js', 'export {};\n']],
	});
	const invocations = [];

	try {
		const status = runPrettier(['src/example.js'], {
			spawn: (...arguments_) => {
				invocations.push(arguments_);
				return { status: 7 };
			},
			workspace: fixture.workspace,
		});

		assert.equal(status, 7);
		assert.equal(invocations.length, 1);

		const [command, commandArguments, options] = invocations[0];

		assert.equal(command, process.execPath);
		assert.equal(
			commandArguments[0],
			join(
				fixture.workspace,
				'node_modules',
				'prettier',
				'bin',
				'prettier.cjs',
			),
		);
		assert.equal(
			commandArguments.at(-1),
			join(fixture.workspace, 'src', 'example.js'),
		);
		assert.equal(options.cwd, fixture.workspace);
		assert.equal(options.shell, false);
	} finally {
		fixture.remove();
	}
});

test('reads the changed files from CODE_FILES', () => {
	assert.throws(() => main({}), /CODE_FILES is required/);
	assert.throws(
		() => main({ CODE_FILES: '["../outside.js"]' }),
		/CODE_FILES path escapes the workspace/,
	);
});

test('resolves the checkout from GITHUB_WORKSPACE', () => {
	const fixture = createWorkspaceFixture({
		files: [['src/example.js', 'export {};\n']],
	});
	let commandArguments;

	try {
		main(
			{
				GITHUB_WORKSPACE: fixture.workspace,
				CODE_FILES: '["src/example.js"]',
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
			join(fixture.workspace, 'src', 'example.js'),
		);
	} finally {
		fixture.remove();
	}
});
