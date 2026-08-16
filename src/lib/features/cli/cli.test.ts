import { afterEach, describe, expect, test } from 'vitest';

import { createGitFixture } from '../git/testing/git-fixture.ts';
import type { GitFixture } from '../git/testing/git-fixture.ts';
import { runCli } from './cli.ts';
import { ExitCode } from './exit-code.ts';

const context = {
	version: '9.9.9',
	cwd: process.cwd(),
	env: {},
	now: () => new Date('2026-08-16T10:00:00.000Z'),
};

describe('valid invocations succeed', () => {
	test.for([['--help'], ['-h']])('%s prints usage', async (argv) => {
		const outcome = await runCli(argv, context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stderr).toBe('');
		expect(outcome.stdout).toContain('Usage: docket <command> [options]');
	});

	test.for([['--version'], ['-v']])('%s prints only the version', async (argv) => {
		const outcome = await runCli(argv, context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stderr).toBe('');
		expect(outcome.stdout).toBe('9.9.9\n');
	});

	test('a bare invocation prints usage', async () => {
		const outcome = await runCli([], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stdout).toContain('Usage: docket <command> [options]');
	});
});

describe('misuse fails', () => {
	test('an unknown command is rejected by name', async () => {
		const outcome = await runCli(['deploy-everything'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('unknown command: deploy-everything');
		expect(outcome.stderr).toContain('docket --help');
	});

	test('an unknown flag is rejected without leaking parser advice', async () => {
		const outcome = await runCli(['--wat'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('--wat');
		expect(outcome.stderr).not.toContain('positional argument');
	});

	test('a value passed to a boolean flag is rejected', async () => {
		const outcome = await runCli(['--version=2'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stdout).toBe('');
	});
});

describe('--json output', () => {
	test('a success is an envelope on stdout', async () => {
		const outcome = await runCli(['--version', '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stderr).toBe('');
		expect(outcome.stdout).toBe('{"ok":true,"data":{"kind":"version","name":"docket","version":"9.9.9"}}\n');
	});

	test('a failure is an envelope on stdout too, so a pipe keeps working', async () => {
		const outcome = await runCli(['nope', '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stderr).toBe('');
		expect(JSON.parse(outcome.stdout)).toEqual({
			ok: false,
			error: { code: 'unknown_command', message: 'unknown command: nope' },
		});
	});

	test('JSON is honoured even when the parse is what failed', async () => {
		const outcome = await runCli(['--wat', '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(JSON.parse(outcome.stdout).error.code).toBe('invalid_option');
	});

	test('repeated runs are byte-identical', async () => {
		const first = await runCli(['--version', '--json'], context);
		const second = await runCli(['--version', '--json'], context);

		expect(first.stdout).toBe(second.stdout);
	});

	test('flag order does not change the bytes', async () => {
		const before = await runCli(['--json', '--version'], context);
		const after = await runCli(['--version', '--json'], context);

		expect(before.stdout).toBe(after.stdout);
	});
});

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
