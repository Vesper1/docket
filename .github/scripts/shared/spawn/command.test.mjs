import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { runCommand, runNodeBinary } from './command.mjs';

test('runs a command without a shell and returns its status', () => {
	const invocations = [];
	const status = runCommand({
		command: 'unzip',
		arguments_: ['-q', 'pmd.zip'],
		spawn: (...arguments_) => {
			invocations.push(arguments_);
			return { status: 3 };
		},
		workspace: '/work',
	});

	assert.equal(status, 3);
	assert.deepEqual(invocations, [
		[
			'unzip',
			['-q', 'pmd.zip'],
			{ cwd: '/work', stdio: 'inherit', shell: false },
		],
	]);
});

test('runs the workspace copy of a Node CLI and names it in failures', () => {
	const binary = join('node_modules', 'eslint', 'bin', 'eslint.js');
	let invocation;

	assert.equal(
		runNodeBinary({
			binary,
			arguments_: ['--max-warnings', '0'],
			label: 'ESLint',
			spawn: (...arguments_) => {
				invocation = arguments_;
				return { status: 0 };
			},
			workspace: '/work',
		}),
		0,
	);
	assert.deepEqual(invocation[0], process.execPath);
	assert.deepEqual(invocation[1], [
		join('/work', binary),
		'--max-warnings',
		'0',
	]);

	assert.throws(
		() =>
			runNodeBinary({
				binary,
				arguments_: [],
				label: 'ESLint',
				spawn: () => ({ status: null, signal: 'SIGKILL' }),
				workspace: '/work',
			}),
		/ESLint terminated with signal SIGKILL/,
	);
});
