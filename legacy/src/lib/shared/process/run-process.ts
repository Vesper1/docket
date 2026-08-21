import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ProcessResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	/**
	 * Why Docket stopped the process, when it was Docket that stopped it.
	 * `null` means the command decided its own fate.
	 */
	readonly terminatedBy: TerminationReason | null;
	/** The OS refused to start the command at all (missing binary, bad cwd, etc.). */
	readonly startError: string | null;
}

export type TerminationReason = 'timeout' | 'cancellation';

export interface RunProcessOptions {
	readonly cwd?: string;
	/** Extra variables layered on top of the parent environment. */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * How long the command may run. A Salesforce validation or a quality gate
	 * that hangs must not hold a deployment lock open indefinitely.
	 */
	readonly timeoutMs?: number;
	/** Stops the command early — a cancelled workflow job, a failed gate. */
	readonly signal?: AbortSignal;
	/**
	 * Variables to drop from the inherited environment.
	 *
	 * A quality gate runs code from the pull request, so the deployment
	 * credentials must not be in its environment. This is a barrier, not a
	 * sandbox: a determined command can still read whatever the account it runs
	 * as can read.
	 */
	readonly removeEnv?: readonly string[];
}

/**
 * How long a terminated process gets to exit on its own before it is killed.
 * `sf` writes a JSON body on the way out, and losing it turns a clean failure
 * into an unexplained one.
 */
const GRACE_MS = 2_000;

/**
 * Runs a command with an argument array and no shell, so nothing in a branch
 * name, a file path or a config value can be read as shell syntax.
 *
 * A non-zero exit is a normal outcome here, not an exception: the caller
 * decides what it means.
 */
export const runProcess = (
	command: string,
	args: readonly string[],
	options: RunProcessOptions = {},
): Promise<ProcessResult> => {
	return new Promise((resolve) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, [...args], {
				cwd: options.cwd,
				env: environmentOf(options),
				shell: false,
			});
		} catch (error) {
			resolve(startFailure(error));
			return;
		}

		let stdout = '';
		let stderr = '';
		let terminatedBy: TerminationReason | null = null;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		/** Ask, then insist. A process that ignores SIGTERM still has to go. */
		const terminate = (reason: TerminationReason) => {
			if (terminatedBy !== null) return;
			terminatedBy = reason;
			child.kill('SIGTERM');
			const insist = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
			insist.unref();
			child.once('close', () => clearTimeout(insist));
		};

		timer =
			options.timeoutMs === undefined ? undefined : setTimeout(() => terminate('timeout'), options.timeoutMs);
		const onAbort = () => terminate('cancellation');
		options.signal?.addEventListener('abort', onAbort, { once: true });
		if (options.signal?.aborted === true) terminate('cancellation');

		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			resolve(result);
		};

		child.on('error', (error) => {
			finish({ stdout, stderr, exitCode: 127, terminatedBy: null, startError: messageOf(error) });
		});

		child.on('close', (code, signal) => {
			finish({
				stdout,
				stderr,
				exitCode: code ?? terminationCode(signal),
				terminatedBy,
				startError: null,
			});
		});
	});
};

const startFailure = (error: unknown): ProcessResult => {
	return { stdout: '', stderr: '', exitCode: 127, terminatedBy: null, startError: messageOf(error) };
};

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const environmentOf = (options: RunProcessOptions): NodeJS.ProcessEnv => {
	if (options.env === undefined && options.removeEnv === undefined) return process.env;

	const environment = { ...process.env, ...options.env };
	for (const name of options.removeEnv ?? []) delete environment[name];

	return environment;
};

/**
 * A signalled process reports no exit code of its own. Any signal collapses to
 * a flat 128 rather than the shell's 128+n: `terminatedBy` already says whether
 * Docket stopped the process and why, and nothing here branches on which signal
 * it took to stop it.
 */
const terminationCode = (signal: NodeJS.Signals | null): number => signal === null ? 1 : 128;
