import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import {ok} from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import { runGit } from './git-command.ts';
import { readChanges } from './read-changes.ts';
import { createGitFixture } from './testing/git-fixture.ts';
import type { GitFixture, GitFixtureInput } from './testing/git-fixture.ts';

const KEPT = 'force-app/main/default/classes/Foo.cls';
const SUBJECT = 'force-app/main/default/classes/Bar.cls';

const ADDITION = ok([{ status: 'added', path: SUBJECT }]);

let fixture: GitFixture | undefined;

afterEach(async () => {
	await fixture?.remove();
	fixture = undefined;
});

/** Builds the fixture and asks for the changes between its two commits. */
const changesOf = async (input: GitFixtureInput) => {
	fixture = await createGitFixture(input);
	return readChanges({
		cwd: fixture.directory,
		baseSha: fixture.baseSha,
		headSha: fixture.headSha,
	});
};

/** One class survives untouched, one class appears in the head commit. */
const addedClass = (): Promise<GitFixture> => {
	return createGitFixture({
		base: { [KEPT]: 'public class Foo {}' },
		head: { [KEPT]: 'public class Foo {}', [SUBJECT]: 'public class Bar {}' },
	});
};

describe('reading the changes between two exact commits', () => {
	test('a path only the head commit has is added', async () => {
		const result = await changesOf({
			base: { [KEPT]: 'public class Foo {}' },
			head: { [KEPT]: 'public class Foo {}', [SUBJECT]: 'public class Bar {}' },
		});

		expect(result).toEqual(ADDITION);
	});

	test('a path in both commits with different contents is modified', async () => {
		const result = await changesOf({
			base: { [SUBJECT]: 'public class Bar {}' },
			head: { [SUBJECT]: 'public class Bar { // edited\n}' },
		});

		expect(result).toEqual(ok([{ status: 'modified', path: SUBJECT }]));
	});

	test('a path only the base commit has is deleted', async () => {
		const result = await changesOf({
			base: { [KEPT]: 'public class Foo {}', [SUBJECT]: 'public class Bar {}' },
			head: { [KEPT]: 'public class Foo {}' },
		});

		expect(result).toEqual(ok([{ status: 'deleted', path: SUBJECT }]));
	});

	test('a rename keeps both the old and the new path', async () => {
		const body = 'public class Bar {\n\tpublic static void run() {\n\t\tSystem.debug(1);\n\t}\n}';

		const result = await changesOf({
			base: { [SUBJECT]: body },
			head: { 'force-app/main/default/classes/Renamed.cls': body },
		});

		expect(result).toEqual(
			ok([
				{
					status: 'renamed',
					path: 'force-app/main/default/classes/Renamed.cls',
					previousPath: SUBJECT,
				},
			]),
		);
	});

	test('an unchanged path is not a change', async () => {
		const result = await changesOf({
			base: { [KEPT]: 'public class Foo {}' },
			head: { [KEPT]: 'public class Foo {}', [SUBJECT]: 'public class Bar {}' },
		});

		expect(result).toEqual(ADDITION);
	});

	test('changing the head SHA changes the result', async () => {
		fixture = await addedClass();
		const from = { cwd: fixture.directory, baseSha: fixture.baseSha };

		const atHead = await readChanges({ ...from, headSha: fixture.headSha });
		const atBase = await readChanges({ ...from, headSha: fixture.baseSha });

		expect(atHead).toEqual(ADDITION);
		expect(atBase).toEqual(ok([]));
	});

	test('changing the base SHA changes the result', async () => {
		fixture = await addedClass();
		const to = { cwd: fixture.directory, headSha: fixture.headSha };

		const fromBase = await readChanges({ ...to, baseSha: fixture.baseSha });
		const fromHead = await readChanges({ ...to, baseSha: fixture.headSha });

		expect(fromBase).toEqual(ADDITION);
		expect(fromHead).toEqual(ok([]));
	});

	test('the working tree cannot enter the result', async () => {
		fixture = await addedClass();
		await writeFile(
			join(fixture.directory, 'force-app/main/default/classes/Baz.cls'),
			'public class Baz {}',
			'utf8',
		);
		await writeFile(join(fixture.directory, KEPT), '// uncommitted edit', 'utf8');

		const result = await readChanges({
			cwd: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
		});

		expect(result).toEqual(ADDITION);
	});
});

describe('a change Docket cannot answer for is refused', () => {
	test('a status outside the four Docket classifies is an error, not a dropped path', async () => {
		const repository = await typeChangeRepository();

		try {
			const result = await readChanges({
				cwd: repository.directory,
				baseSha: repository.baseSha,
				headSha: repository.headSha,
			});

			expect(errorOf(result).code).toBe(ErrorCode.unsupportedChange);
		} finally {
			await rm(repository.directory, { recursive: true, force: true });
		}
	});

	test('a ref the repository does not have is an error, not an empty result', async () => {
		fixture = await addedClass();

		const result = await readChanges({
			cwd: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: '0'.repeat(40),
		});

		expect(errorOf(result).code).toBe(ErrorCode.gitFailed);
	});
});

/**
 * A regular file replaced by a symlink. git reports this as `T`, a status no
 * Salesforce metadata mapping can honour, so it is the cheapest real example
 * of a change Docket must refuse rather than guess at.
 */
const typeChangeRepository = async (): Promise<{
	readonly directory: string;
	readonly baseSha: string;
	readonly headSha: string;
}> => {
	const directory = await mkdtemp(join(tmpdir(), 'docket-typechange-'));
	const identity = {
		GIT_AUTHOR_NAME: 'Docket Fixture',
		GIT_AUTHOR_EMAIL: 'fixture@docket.invalid',
		GIT_COMMITTER_NAME: 'Docket Fixture',
		GIT_COMMITTER_EMAIL: 'fixture@docket.invalid',
	};
	const git = (...args: string[]) => runGit(args, { cwd: directory, env: identity });

	await git('init', '--quiet', '--initial-branch=main');
	await writeFile(join(directory, 'link'), 'plain file', 'utf8');
	await git('add', '--all');
	await git('commit', '--quiet', '--message', 'base');

	await unlink(join(directory, 'link'));
	await symlink('elsewhere', join(directory, 'link'));
	await git('add', '--all');
	await git('commit', '--quiet', '--message', 'head');

	const head = await git('rev-parse', 'HEAD');
	const base = await git('rev-parse', 'HEAD~1');
	return { directory, baseSha: base.stdout.trim(), headSha: head.stdout.trim() };
}
