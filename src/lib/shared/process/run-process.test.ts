import { describe, expect, test } from 'vitest';

import { runProcess } from './run-process.ts';

/** Runs a snippet in this Node, which every machine that runs the tests has. */
function node(source: string, options = {}) {
	return runProcess(process.execPath, ['-e', source], options);
}

describe('running a command', () => {
	test('captures stdout, stderr and the exit code', async () => {
		const result = await node(
			'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
		);

		expect(result).toEqual({
			stdout: 'out',
			stderr: 'err',
			exitCode: 3,
			terminatedBy: null,
			startError: null,
		});
	});

	test('arguments are values, never shell syntax', async () => {
		const result = await runProcess(process.execPath, [
			'-e',
			'process.stdout.write(process.argv[1] ?? "")',
			'; rm -rf /',
		]);

		expect(result.stdout).toBe('; rm -rf /');
		expect(result.exitCode).toBe(0);
	});

	test('the working directory is the one given', async () => {
		const result = await node('process.stdout.write(process.cwd())', { cwd: '/tmp' });

		expect(result.stdout).toContain('tmp');
	});

	test('extra environment variables are layered on the parent environment', async () => {
		const result = await node('process.stdout.write(`${process.env.DOCKET_TEST}:${!!process.env.PATH}`)', {
			env: { DOCKET_TEST: 'value' },
		});

		expect(result.stdout).toBe('value:true');
	});

	test('a missing binary is an explicit result, not a rejected promise', async () => {
		const result = await runProcess('docket-no-such-binary', []);

		expect(result.exitCode).toBe(127);
		expect(result.startError).toContain('docket-no-such-binary');
	});

	test('a missing working directory is an explicit start failure too', async () => {
		const result = await runProcess(process.execPath, ['--version'], {
			cwd: '/docket/definitely/not/a/directory',
		});

		expect(result.exitCode).toBe(127);
		expect(result.startError).not.toBeNull();
	});
});

describe('stopping a command Docket must not wait for', () => {
	test('a hanging command is terminated and reported failed', async () => {
		const result = await node('setInterval(() => {}, 1000)', { timeoutMs: 150 });

		expect(result.terminatedBy).toBe('timeout');
		expect(result.exitCode).not.toBe(0);
	});

	test('output produced before the timeout is kept', async () => {
		const result = await node('process.stdout.write("partial"); setInterval(() => {}, 1000)', {
			timeoutMs: 150,
		});

		expect(result.stdout).toBe('partial');
		expect(result.terminatedBy).toBe('timeout');
	});

	test('a command that finishes in time is untouched', async () => {
		const result = await node('process.stdout.write("done")', { timeoutMs: 10_000 });

		expect(result).toEqual({
			stdout: 'done',
			stderr: '',
			exitCode: 0,
			terminatedBy: null,
			startError: null,
		});
	});

	test('cancellation stops a command and says so', async () => {
		const controller = new AbortController();
		const running = node('setInterval(() => {}, 1000)', { signal: controller.signal });

		controller.abort();

		const result = await running;
		expect(result.terminatedBy).toBe('cancellation');
		expect(result.exitCode).not.toBe(0);
	});

	test('a process that ignores SIGTERM is still killed', async () => {
		const result = await node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)', {
			timeoutMs: 150,
		});

		expect(result.terminatedBy).toBe('timeout');
		expect(result.exitCode).not.toBe(0);
	}, 10_000);
});
