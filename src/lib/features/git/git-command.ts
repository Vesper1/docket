import { runProcess } from '../../shared/process/run-process.ts';
import type { ProcessResult } from '../../shared/process/run-process.ts';

/**
 * Environment that makes git answer only to what Docket passes it.
 *
 * A run must not depend on the machine it happens on: a developer's
 * `commit.gpgsign`, an `init.defaultBranch`, a global hooks path or a
 * localised message would all change the output otherwise. Actions runners
 * and laptops must produce the same bytes.
 */
const ISOLATED_GIT_ENV = {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null',
	GIT_TERMINAL_PROMPT: '0',
	LC_ALL: 'C',
} as const;

export interface GitCommandOptions {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
}

/** Runs one git command in an isolated environment. */
export function runGit(
	args: readonly string[],
	options: GitCommandOptions,
): Promise<ProcessResult> {
	return runProcess('git', args, {
		cwd: options.cwd,
		env: { ...ISOLATED_GIT_ENV, ...options.env },
	});
}
