import { access } from 'node:fs/promises';

import { afterEach, describe, expect, test } from 'vitest';

import { runGit } from '../git-command.ts';
import { createGitFixture } from './git-fixture.ts';
import type { GitFixture } from './git-fixture.ts';

const FULL_SHA = /^[0-9a-f]{40}$/;

let fixture: GitFixture | undefined;

afterEach(async () => {
	await fixture?.remove();
	fixture = undefined;
});

describe('the git fixture', () => {
	test('exposes both full SHAs', async () => {
		fixture = await createGitFixture({
			base: { 'force-app/main/default/classes/Foo.cls': 'public class Foo {}' },
			head: { 'force-app/main/default/classes/Foo.cls': 'public class Foo { // edited\n}' },
		});

		expect(fixture.baseSha).toMatch(FULL_SHA);
		expect(fixture.headSha).toMatch(FULL_SHA);
		expect(fixture.baseSha).not.toBe(fixture.headSha);
	});

	test('both SHAs are real commits in the repository', async () => {
		fixture = await createGitFixture({ base: { 'a.txt': 'a' }, head: { 'a.txt': 'b' } });

		for (const sha of [fixture.baseSha, fixture.headSha]) {
			const { stdout, exitCode } = await runGit(['cat-file', '-t', sha], {
				cwd: fixture.directory,
			});

			expect(exitCode).toBe(0);
			expect(stdout.trim()).toBe('commit');
		}
	});

	test('head is a direct child of base', async () => {
		fixture = await createGitFixture({ base: { 'a.txt': 'a' }, head: { 'a.txt': 'b' } });

		const { stdout } = await runGit(['rev-parse', `${fixture.headSha}^`], {
			cwd: fixture.directory,
		});

		expect(stdout.trim()).toBe(fixture.baseSha);
	});

	test('identical input produces identical SHAs', async () => {
		const input = { base: { 'a.txt': 'a' }, head: { 'a.txt': 'b' } };

		fixture = await createGitFixture(input);
		const twin = await createGitFixture(input);

		try {
			expect(twin.baseSha).toBe(fixture.baseSha);
			expect(twin.headSha).toBe(fixture.headSha);
		} finally {
			await twin.remove();
		}
	});

	test('different content produces different SHAs', async () => {
		fixture = await createGitFixture({ base: { 'a.txt': 'a' }, head: { 'a.txt': 'b' } });
		const other = await createGitFixture({ base: { 'a.txt': 'a' }, head: { 'a.txt': 'c' } });

		try {
			expect(other.baseSha).toBe(fixture.baseSha);
			expect(other.headSha).not.toBe(fixture.headSha);
		} finally {
			await other.remove();
		}
	});

	test('remove deletes the directory and tolerates a second call', async () => {
		const disposable = await createGitFixture({ base: {}, head: { 'a.txt': 'a' } });

		await disposable.remove();
		await disposable.remove();

		await expect(access(disposable.directory)).rejects.toThrow();
	});

	test('the repository ignores the machine it runs on', async () => {
		fixture = await createGitFixture({ base: { 'a.txt': 'a' }, head: { 'a.txt': 'b' } });

		const { stdout } = await runGit(['log', '-1', '--format=%an <%ae>'], {
			cwd: fixture.directory,
		});

		expect(stdout.trim()).toBe('Docket Fixture <fixture@docket.invalid>');
	});
});
