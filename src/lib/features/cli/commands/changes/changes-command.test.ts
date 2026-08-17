import { afterEach, describe, expect, test } from 'vitest';

import { createGitFixture } from '../../../git/testing/git-fixture.ts';
import type { GitFixture } from '../../../git/testing/git-fixture.ts';
import { runCli } from '../../cli.ts';
import { ExitCode } from '../../exit-code.ts';

const context = {
	version: '9.9.9',
	cwd: process.cwd(),
	env: {},
	now: () => new Date('2026-08-16T10:00:00.000Z'),
};

describe('docket changes', () => {
	const CLASS = 'force-app/main/default/classes/Bar.cls';
	let fixture: GitFixture | undefined;

	afterEach(async () => {
		await fixture?.remove();
		fixture = undefined;
	});

	async function repository(): Promise<GitFixture> {
		return createGitFixture({
			base: { 'force-app/main/default/classes/Foo.cls': 'public class Foo {}' },
			head: {
				'force-app/main/default/classes/Foo.cls': 'public class Foo {}',
				[CLASS]: 'public class Bar {}',
			},
		});
	}

	test('lists the changes between the two given commits', async () => {
		fixture = await repository();

		const outcome = await runCli(
			['changes', '--repo', fixture.directory, '--base', fixture.baseSha, '--head', fixture.headSha],
			context,
		);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stdout).toBe(`added    ${CLASS}\n`);
	});

	test('an unknown ref exits non-zero and produces no listing', async () => {
		fixture = await repository();

		const outcome = await runCli(
			['changes', '--repo', fixture.directory, '--base', fixture.baseSha, '--head', 'f'.repeat(40)],
			context,
		);

		expect(outcome.exitCode).not.toBe(ExitCode.success);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('git diff failed');
	});

	test('an unknown ref in JSON mode carries a code and no changes', async () => {
		fixture = await repository();

		const outcome = await runCli(
			[
				'changes',
				'--json',
				'--repo',
				fixture.directory,
				'--base',
				'0000000000000000000000000000000000000000',
				'--head',
				fixture.headSha,
			],
			context,
		);

		expect(outcome.exitCode).not.toBe(ExitCode.success);
		const payload = JSON.parse(outcome.stdout);
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe('git_failed');
		expect(payload.data).toBeUndefined();
	});

	test('a missing ref option is refused instead of guessed', async () => {
		fixture = await repository();

		const outcome = await runCli(['changes', '--repo', fixture.directory, '--base', fixture.baseSha], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('--head');
	});

	test('--repo defaults to where the process was started', async () => {
		fixture = await repository();

		const outcome = await runCli(['changes', '--base', fixture.baseSha, '--head', fixture.headSha], {
			...context,
			cwd: fixture.directory,
		});

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stdout).toBe(`added    ${CLASS}\n`);
	});
});
