import type { DocketError } from '../../../shared/result/docket-error.ts';
import type { Result } from '../../../shared/result/result.ts';
import type { CliData } from '../render.ts';
import type { PipelineContext } from './pipeline-options.ts';

/**
 * One flag, declared in the only place that reads it.
 *
 * A flag has no existence outside the command that owns it: `--create-pr` is
 * not a word the program knows, it is something `rollback` accepts. That is
 * what lets an operator's mistake — the right flag on the wrong command — stop
 * the run instead of being parsed and silently ignored.
 */
export interface FlagSpec {
	readonly type: 'string' | 'boolean';
	readonly short?: string;
	/** Printed by `docket <command> --help`; there is no undocumented flag. */
	readonly description: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

/**
 * The options a command is handed, derived from the flags it declares. Reading
 * a flag it did not declare is a compile error rather than a silent undefined.
 */
export type FlagValues<Flags extends FlagSpecs> = {
	readonly [Name in keyof Flags]?: Flags[Name]['type'] extends 'boolean' ? boolean : string;
};

export type CommandResult =
	| Result<CliData, DocketError>
	| Promise<Result<CliData, DocketError>>;

/** A command with its flag types erased, which is all the dispatcher needs. */
export interface Command {
	readonly name: string;
	/** One line, shown in `docket --help`. */
	readonly summary: string;
	readonly flags: FlagSpecs;
	readonly run: (
		values: Readonly<Record<string, unknown>>,
		context: PipelineContext,
	) => CommandResult;
}

export const defineCommand = <const Flags extends FlagSpecs>(definition: {
	readonly name: string;
	readonly summary: string;
	readonly flags: Flags;
	readonly run: (options: FlagValues<Flags>, context: PipelineContext) => CommandResult;
}): Command => {
	return {
		name: definition.name,
		summary: definition.summary,
		flags: definition.flags,
		// The only cast in the dispatch path, and a safe one: argv is parsed
		// with exactly these flags, so the erased record holds exactly the
		// options the command declared.
		run: (values, context) => definition.run(values as FlagValues<Flags>, context),
	};
}

/**
 * The flags that belong to the program rather than to any command, so they
 * mean the same thing everywhere and no command may redefine them.
 */
export const GLOBAL_FLAGS = {
	help: { type: 'boolean', short: 'h', description: 'Show this help' },
	version: { type: 'boolean', short: 'v', description: 'Show the version' },
	json: { type: 'boolean', description: 'Emit machine-readable output on stdout' },
} as const satisfies FlagSpecs;
