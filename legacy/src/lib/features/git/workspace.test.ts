import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import { err, isErr, isOk, ok } from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import { readFileAtCommit } from './read-file.ts';
import { createGitFixture } from './testing/git-fixture.ts';
import type { GitFixture } from './testing/git-fixture.ts';
import { withWorkspace } from './workspace.ts';

const CONFIG = 'docket.yml';

let fixture: GitFixture | undefined;

afterEach(async () => {
	await fixture?.remove();
	fixture = undefined;
});

const repository = async (): Promise<GitFixture> => {
	return createGitFixture({
		base: {
			[CONFIG]: 'version: 1\n',
			'force-app/main/default/classes/Foo.cls': 'public class Foo {}',
		},
		head: {
			[CONFIG]: 'version: 1\nsourceRoot: hijacked\n',
			'force-app/main/default/classes/Foo.cls': 'public class Foo {}',
			'force-app/main/default/classes/Bar.cls': 'public class Bar {}',
		},
	});
};

describe('reading a file at an exact commit', () => {
	test('the base commit answers with its own version of the file', async () => {
		fixture = await repository();

		const trusted = await readFileAtCommit({
			cwd: fixture.directory,
			sha: fixture.baseSha,
			path: CONFIG,
		});

		expect(trusted).toEqual(ok('version: 1\n'));
	});

	test('what the pull request did to that file is not what is read', async () => {
		fixture = await repository();

		const head = await readFileAtCommit({
			cwd: fixture.directory,
			sha: fixture.headSha,
			path: CONFIG,
		});

		expect(isOk(head) && head.value).toContain('hijacked');
	});

	test('a file the commit does not have is an explicit failure', async () => {
		fixture = await repository();

		const missing = await readFileAtCommit({
			cwd: fixture.directory,
			sha: fixture.baseSha,
			path: 'nope.yml',
		});

		expect(errorOf(missing).code).toBe(ErrorCode.gitFailed);
	});
});

describe('an isolated workspace', () => {
	test('holds exactly the tree of the commit it was given', async () => {
		fixture = await repository();

		const files = await withWorkspace({ cwd: fixture.directory, sha: fixture.headSha }, async (workspace) =>
			ok({
				bar: await readFile(
					join(workspace.directory, 'force-app/main/default/classes/Bar.cls'),
					'utf8',
				),
				config: await readFile(join(workspace.directory, CONFIG), 'utf8'),
			}),
		);

		expect(isOk(files) && files.value.bar).toBe('public class Bar {}');
		expect(isOk(files) && files.value.config).toContain('hijacked');
	});

	test('the base commit workspace does not contain the head commit files', async () => {
		fixture = await repository();

		const found = await withWorkspace({ cwd: fixture.directory, sha: fixture.baseSha }, async (workspace) =>
			ok(
				await access(join(workspace.directory, 'force-app/main/default/classes/Bar.cls')).then(
					() => true,
					() => false,
				),
			),
		);

		expect(isOk(found) && found.value).toBe(false);
	});

	test('local uncommitted and untracked files cannot reach it', async () => {
		fixture = await repository();
		await writeFile(join(fixture.directory, 'force-app/main/default/classes/Foo.cls'), '// dirty', 'utf8');
		await writeFile(join(fixture.directory, 'untracked.txt'), 'local only', 'utf8');

		const seen = await withWorkspace({ cwd: fixture.directory, sha: fixture.headSha }, async (workspace) =>
			ok({
				foo: await readFile(
					join(workspace.directory, 'force-app/main/default/classes/Foo.cls'),
					'utf8',
				),
				untracked: await access(join(workspace.directory, 'untracked.txt')).then(
					() => true,
					() => false,
				),
			}),
		);

		expect(isOk(seen) && seen.value.foo).toBe('public class Foo {}');
		expect(isOk(seen) && seen.value.untracked).toBe(false);
	});

	test('it is removed after the work succeeds', async () => {
		fixture = await repository();
		let path = '';

		await withWorkspace({ cwd: fixture.directory, sha: fixture.headSha }, async (workspace) => {
			path = workspace.directory;
			return ok(null);
		});

		await expect(access(path)).rejects.toThrow();
	});

	test('it is removed after the work fails too', async () => {
		fixture = await repository();
		let path = '';

		const result = await withWorkspace(
			{ cwd: fixture.directory, sha: fixture.headSha },
			async (workspace) => {
				path = workspace.directory;
				return err({ code: ErrorCode.gitFailed, message: 'work refused' });
			},
		);

		expect(isErr(result)).toBe(true);
		await expect(access(path)).rejects.toThrow();
	});

	test('an unknown commit produces no workspace at all', async () => {
		fixture = await repository();

		const result = await withWorkspace({ cwd: fixture.directory, sha: 'no-such-sha' }, async () =>
			ok('unreachable'),
		);

		expect(errorOf(result).code).toBe(ErrorCode.gitFailed);
	});
});
