import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createWorkspaceFixture } from '../../shared/testing/workspace-fixture.mjs';

import { runApexPmd } from './check.mjs';

const createPmdFixture = (className = 'Example.cls') =>
	createWorkspaceFixture({
		files: [
			[join('force-app', 'classes', className), 'public class Example {}\n'],
			[join('.github', 'pmd', 'apex-ruleset.xml'), '<ruleset/>\n'],
		],
	});

test('downloads, extracts, and runs PMD without a shell', () => {
	const fixture = createPmdFixture();
	const invocations = [];
	let fileListContents;
	let workDirectory;
	const spawn = (command, arguments_, options) => {
		invocations.push({ command, arguments_, options });

		if (command === 'curl') {
			const archive = arguments_[arguments_.indexOf('--output') + 1];
			workDirectory = dirname(archive);
			writeFileSync(archive, 'archive bytes');
			return { status: 0 };
		}

		if (command === 'unzip') {
			const destination = arguments_[arguments_.indexOf('-d') + 1];
			const binary = join(destination, 'pmd-bin-7.7.0', 'bin', 'pmd');
			mkdirSync(dirname(binary), { recursive: true });
			writeFileSync(binary, '');
			chmodSync(binary, 0o755);
			return { status: 0 };
		}

		const fileList = arguments_[arguments_.indexOf('--file-list') + 1];
		fileListContents = readFileSync(fileList, 'utf8');
		return { status: 7 };
	};

	try {
		const status = runApexPmd(
			{
				APEX_FILES: JSON.stringify(['force-app/classes/Example.cls']),
				PMD_DIST_SHA256: createHash('sha256')
					.update('archive bytes')
					.digest('hex'),
			},
			{
				runnerTemp: fixture.runnerTemp,
				spawn,
				stdout: { write: () => {} },
				workspace: fixture.workspace,
			},
		);

		assert.equal(status, 7);
		assert.deepEqual(
			invocations.map(({ command }) =>
				command.includes('pmd-bin-') ? 'pmd' : command,
			),
			['curl', 'unzip', 'pmd'],
		);
		assert.ok(invocations.every(({ options }) => options.shell === false));
		assert.equal(
			fileListContents,
			`${join(fixture.workspace, 'force-app', 'classes', 'Example.cls')}\n`,
		);
		assert.equal(existsSync(workDirectory), false);
	} finally {
		fixture.remove();
	}
});

test('resolves the checkout from GITHUB_WORKSPACE', () => {
	const fixture = createPmdFixture();

	try {
		assert.throws(
			() =>
				runApexPmd(
					{
						GITHUB_WORKSPACE: fixture.workspace,
						RUNNER_TEMP: fixture.runnerTemp,
						APEX_FILES: JSON.stringify(['force-app/classes/Missing.cls']),
					},
					{ spawn: () => ({ status: 0 }) },
				),
			/APEX_FILES path does not exist: force-app\/classes\/Missing\.cls/,
		);
	} finally {
		fixture.remove();
	}
});

test('rejects line breaks before creating a PMD file list', () => {
	const fixture = createPmdFixture();

	try {
		assert.throws(
			() =>
				runApexPmd(
					{
						APEX_FILES: JSON.stringify(['force-app/classes/Bad\nInjected.cls']),
					},
					{ runnerTemp: fixture.runnerTemp, workspace: fixture.workspace },
				),
			/line break/,
		);
	} finally {
		fixture.remove();
	}
});

test('refuses an archive that does not match the pinned digest', () => {
	const fixture = createPmdFixture();

	try {
		assert.throws(
			() =>
				runApexPmd(
					{ APEX_FILES: JSON.stringify(['force-app/classes/Example.cls']) },
					{
						runnerTemp: fixture.runnerTemp,
						spawn: (command, arguments_) => {
							writeFileSync(
								arguments_[arguments_.indexOf('--output') + 1],
								'tampered bytes',
							);
							return { status: 0 };
						},
						stdout: { write: () => {} },
						workspace: fixture.workspace,
					},
				),
			/digest mismatch/,
		);
	} finally {
		fixture.remove();
	}
});
