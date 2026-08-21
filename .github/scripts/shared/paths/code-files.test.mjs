import assert from 'node:assert/strict';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseCodeFiles, resolveCodeFiles } from './code-files.mjs';
import { createWorkspaceFixture } from '../testing/workspace-fixture.mjs';

test('parses paths with spaces and shell metacharacters without changing them', () => {
	const files = ['src/a class.cls', "src/special ; $(false) ' [code].ts"];

	assert.deepEqual(parseCodeFiles(JSON.stringify(files)), files);
});

test('rejects missing, malformed, empty, and non-string file lists', () => {
	assert.throws(() => parseCodeFiles(undefined), /CODE_FILES is required/);
	assert.throws(() => parseCodeFiles('{'), /valid JSON/);
	assert.throws(() => parseCodeFiles('[]'), /non-empty JSON array/);
	assert.throws(() => parseCodeFiles('["good.js", 42]'), /file paths/);
});

test('names the offending variable in every message', () => {
	assert.throws(
		() => parseCodeFiles(undefined, 'JS_TS_FILES'),
		/JS_TS_FILES is required/,
	);
	assert.throws(
		() =>
			resolveCodeFiles(['../outside.js'], {
				workspace: process.cwd(),
				variableName: 'JS_TS_FILES',
			}),
		/JS_TS_FILES path escapes/,
	);
});

test('resolves paths inside the workspace and rejects escaping paths', () => {
	const fixture = createWorkspaceFixture({
		files: [['src/example.js', 'export {};\n']],
	});
	const outsideFile = join(fixture.root, 'outside.js');

	try {
		writeFileSync(outsideFile, 'export {};\n');
		symlinkSync(outsideFile, join(fixture.workspace, 'src', 'outside-link.js'));

		assert.deepEqual(
			resolveCodeFiles(['src/example.js'], { workspace: fixture.workspace }),
			[join(fixture.workspace, 'src', 'example.js')],
		);
		assert.throws(
			() =>
				resolveCodeFiles(['../outside.js'], { workspace: fixture.workspace }),
			/escapes the workspace/,
		);
		assert.throws(
			() =>
				resolveCodeFiles(['src/outside-link.js'], {
					workspace: fixture.workspace,
				}),
			/escapes the workspace/,
		);
		assert.throws(
			() => resolveCodeFiles(['src'], { workspace: fixture.workspace }),
			/not a file/,
		);
		assert.throws(
			() =>
				resolveCodeFiles(['src/null\0.js'], { workspace: fixture.workspace }),
			/null bytes/,
		);
	} finally {
		fixture.remove();
	}
});
