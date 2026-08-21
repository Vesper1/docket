import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertSha256, buildPmdUrl, installPmd } from './dist.mjs';

const withTemporaryDirectory = (body) => {
	const directory = mkdtempSync(join(tmpdir(), 'docket-pmd-dist-'));

	try {
		return body(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};

test('builds the pinned PMD release URL and rejects unsafe versions', () => {
	assert.equal(
		buildPmdUrl('7.7.0'),
		'https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.7.0/pmd-dist-7.7.0-bin.zip',
	);
	assert.throws(() => buildPmdUrl('../latest'), /semantic version/);
});

test('verifies the PMD archive digest', () => {
	withTemporaryDirectory((directory) => {
		const archive = join(directory, 'pmd.zip');
		writeFileSync(archive, 'archive bytes');
		const digest = createHash('sha256').update('archive bytes').digest('hex');

		assert.doesNotThrow(() => assertSha256(archive, digest.toUpperCase()));
		assert.throws(
			() => assertSha256(archive, '0'.repeat(64)),
			/digest mismatch/,
		);
		assert.throws(() => assertSha256(archive, 'invalid'), /64-character/);
	});
});

test('stops at the failing step instead of extracting a broken download', () => {
	withTemporaryDirectory((directory) => {
		const commands = [];
		const result = installPmd({
			workDirectory: directory,
			digest: '0'.repeat(64),
			spawn: (command) => {
				commands.push(command);
				return { status: 22 };
			},
			version: '7.7.0',
		});

		assert.deepEqual(result, { binary: undefined, status: 22 });
		assert.deepEqual(commands, ['curl']);
	});
});

test('refuses to run a PMD archive that does not match its digest', () => {
	withTemporaryDirectory((directory) => {
		assert.throws(
			() =>
				installPmd({
					workDirectory: directory,
					digest: '0'.repeat(64),
					spawn: (command, arguments_) => {
						writeFileSync(
							arguments_[arguments_.indexOf('--output') + 1],
							'tampered bytes',
						);
						return { status: 0 };
					},
					version: '7.7.0',
				}),
			/digest mismatch/,
		);
	});
});
