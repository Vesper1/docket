import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ExitCode } from '../lib/features/cli/exit-code.ts';

const entryPoint = fileURLToPath(new URL('../bin/docket.ts', import.meta.url));

/** Runs the real binary in a real process, so the exit code is the real one. */
function docket(...args: string[]) {
	const result = spawnSync(process.execPath, [entryPoint, ...args], { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the installed binary', () => {
	test('--help exits 0', () => {
		const { status, stdout, stderr } = docket('--help');

		expect(status).toBe(ExitCode.success);
		expect(stderr).toBe('');
		expect(stdout).toContain('code-first deployment pipelines for Salesforce');
	});

	test('--version exits 0 and prints the package version', () => {
		const { status, stdout } = docket('--version');

		expect(status).toBe(ExitCode.success);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	test('an unknown command exits non-zero', () => {
		const { status, stdout, stderr } = docket('nope');

		expect(status).toBe(ExitCode.usage);
		expect(status).not.toBe(ExitCode.success);
		expect(stdout).toBe('');
		expect(stderr).toContain('unknown command: nope');
	});

	test('--json survives the process boundary intact', () => {
		const { status, stdout, stderr } = docket('--version', '--json');

		expect(status).toBe(ExitCode.success);
		expect(stderr).toBe('');
		expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { name: 'docket' } });
	});

	test('a failing --json run still leaves parseable stdout and a non-zero code', () => {
		const { status, stdout } = docket('nope', '--json');

		expect(status).not.toBe(ExitCode.success);
		expect(JSON.parse(stdout).error.code).toBe('unknown_command');
	});

	test('two identical runs produce identical bytes', () => {
		expect(docket('--version', '--json').stdout).toBe(docket('--version', '--json').stdout);
	});
});
