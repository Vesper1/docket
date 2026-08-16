/**
 * Process exit codes. Kept small and stable: callers and CI scripts branch on
 * these, so a value never changes meaning once it ships.
 */
export const ExitCode = {
	/** The command did what was asked. */
	success: 0,
	/** The command ran but its subject failed (a gate, a validation, a deploy). */
	failure: 1,
	/** The invocation itself was wrong: unknown command, bad flag, bad input. */
	usage: 2,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
