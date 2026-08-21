import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceFixture } from '../../shared/testing/workspace-fixture.mjs';

import { main, runCodeAnalyzer } from './check.mjs';

test('runs the Code Analyzer CLI without a shell and returns its status', () => {
	const fixture = createWorkspaceFixture({
		files: [['force-app/Bad.cls', 'public class Bad {}\n']],
	});
	const invocations = [];

	try {
		const status = runCodeAnalyzer(['force-app/Bad.cls'], {
			spawn: (...arguments_) => {
				invocations.push(arguments_);
				return { status: 1 };
			},
			workspace: fixture.workspace,
		});

		assert.equal(status, 1);
		assert.equal(invocations.length, 1);

		const [command, commandArguments, options] = invocations[0];

		assert.equal(command, 'sf');
		assert.deepEqual(commandArguments.slice(0, 2), ['code-analyzer', 'run']);
		assert.equal(
			commandArguments[commandArguments.indexOf('--target') + 1],
			join(fixture.workspace, 'force-app', 'Bad.cls'),
		);
		assert.equal(
			commandArguments[commandArguments.indexOf('--output-file') + 1],
			join(fixture.workspace, 'code-analyzer-results.json'),
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
		() => main({ CODE_FILES: '["../outside.cls"]' }),
		/CODE_FILES path escapes the workspace/,
	);
});

test('overrides the severity threshold from the environment', () => {
	const fixture = createWorkspaceFixture({
		files: [['force-app/Bad.cls', 'public class Bad {}\n']],
	});
	let commandArguments;

	try {
		main(
			{
				CODE_ANALYZER_SEVERITY_THRESHOLD: '2',
				CODE_FILES: '["force-app/Bad.cls"]',
				GITHUB_WORKSPACE: fixture.workspace,
			},
			{
				spawn: (...arguments_) => {
					commandArguments = arguments_[1];
					return { status: 0 };
				},
			},
		);

		assert.equal(
			commandArguments[commandArguments.indexOf('--severity-threshold') + 1],
			'2',
		);

		assert.throws(
			() =>
				main({
					CODE_ANALYZER_SEVERITY_THRESHOLD: '9',
					CODE_FILES: '["force-app/Bad.cls"]',
					GITHUB_WORKSPACE: fixture.workspace,
				}),
			/CODE_ANALYZER_SEVERITY_THRESHOLD must be a severity between 1 and 5/,
		);
	} finally {
		fixture.remove();
	}
});
