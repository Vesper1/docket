import { describe, expect, test } from 'vitest';

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

	test("a command prints its own options, and not another command's", async () => {
		const outcome = await runCli(['rollback', '--help'], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(outcome.stdout).toContain('Usage: docket rollback [options]');
		expect(outcome.stdout).toContain('--create-pr');
		expect(outcome.stdout).not.toContain('--gates-run');
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

/**
 * A flag is owned by the command that declares it. A recognised option handed
 * to an unrelated command is an operator mistake — the ref, the directory or
 * the org they meant is somewhere else — so it stops the run instead of being
 * parsed and quietly ignored.
 */
describe("another command's flag is refused", () => {
	const BASE = 'a'.repeat(40);
	const HEAD = 'b'.repeat(40);

	test('changes does not take the rollback flag', async () => {
		const outcome = await runCli(['changes', '--base', BASE, '--head', HEAD, '--create-pr'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('--create-pr');
		expect(outcome.stderr).toContain('changes');
	});

	test('plan does not take the manual-step flags', async () => {
		const outcome = await runCli(['plan', '--environment', 'qa', '--step', 'seed-data'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('--step');
	});

	test('history does not take a validation flag', async () => {
		const outcome = await runCli(['history', '--runs', '.docket', '--gates-run', '.docket/gates'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stderr).toContain('--gates-run');
	});

	test('state-audit takes no options of its own', async () => {
		const outcome = await runCli(['state-audit', '--repo', '.'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stderr).toContain('--repo');
	});

	test('the refusal is an invalid_option envelope in JSON mode', async () => {
		const outcome = await runCli(['plan', '--step', 'seed-data', '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(JSON.parse(outcome.stdout).error.code).toBe('invalid_option');
	});

	test('a command still accepts the flags it does declare', async () => {
		const outcome = await runCli(['rollback', '--create-pr', '--json'], context);

		// It gets as far as asking for the run it should invert, which is the
		// proof the flag itself was accepted.
		expect(JSON.parse(outcome.stdout).error).toEqual({
			code: 'missing_option',
			message: 'missing required option: --run',
		});
	});

	test('the global flags stay available to every command', async () => {
		const outcome = await runCli(['state-audit', '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(JSON.parse(outcome.stdout).ok).toBe(true);
	});

	test('options follow the command, so a value is never read as one', async () => {
		const outcome = await runCli(['--base', BASE, 'changes'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stderr).toContain(`unknown command: ${BASE}`);
	});

	test('an unexpected extra argument is refused', async () => {
		const outcome = await runCli(['state-audit', 'yesterday'], context);

		expect(outcome.exitCode).toBe(ExitCode.usage);
		expect(outcome.stderr).toContain('yesterday');
	});
});
