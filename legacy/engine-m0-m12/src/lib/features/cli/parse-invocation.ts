import { parseArgs } from 'node:util';

import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { FlagSpecs } from './commands/command.ts';

/**
 * The command is the first bare word: `docket <command> [options]`.
 *
 * It is read before any option is parsed, because which options exist at all
 * depends on which command was asked for. Options therefore follow the
 * command, and a value can never be mistaken for one.
 */
export const commandNameOf = (argv: readonly string[]): string | undefined => {
	for (const [index, argument] of argv.entries()) {
		if (argument === '--') return argv[index + 1];
		if (!argument.startsWith('-')) return argument;
	}

	return undefined;
};

/**
 * Parses argv against exactly the flags in play — a command's own, plus the
 * global ones — and refuses anything else.
 */
export const parseInvocation = (
	argv: readonly string[],
	flags: FlagSpecs,
	command: string | undefined,
): Result<Readonly<Record<string, unknown>>, DocketError> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: parseOptionsOf(flags),
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		return err(docketError(ErrorCode.invalidOption, optionProblem(error, command)));
	}

	// The command itself is the one positional Docket takes. Anything further
	// is a flag someone forgot to name, or a path in the wrong place.
	const extra = parsed.positionals[command === undefined ? 0 : 1];
	if (extra !== undefined) {
		return err(docketError(ErrorCode.invalidOption, `unexpected argument: ${extra}`));
	}

	return ok(parsed.values);
};

const parseOptionsOf = (flags: FlagSpecs): Record<string, { type: 'string' | 'boolean'; short?: string }> => {
	return Object.fromEntries(
		Object.entries(flags).map(([name, spec]) => [
			name,
			spec.short === undefined ? { type: spec.type } : { type: spec.type, short: spec.short },
		]),
	);
};

/**
 * parseArgs appends a paragraph of advice to its errors. Keep the diagnosis,
 * drop the lecture — and say which command refused the flag, since the same
 * flag is perfectly valid on another one.
 */
const optionProblem = (error: unknown, command: string | undefined): string => {
	const message = error instanceof Error ? error.message : String(error);
	const unknown =
		error instanceof Error && 'code' in error && error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
			? /'(-{1,2}[^']+)'/.exec(message)?.[1]
			: undefined;

	if (unknown === undefined) return message.split('. ')[0] ?? message;

	return command === undefined
		? `unknown option: ${unknown}`
		: `unknown option for \`${command}\`: ${unknown}`;
};
