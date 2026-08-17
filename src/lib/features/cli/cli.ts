import { PRODUCT_NAME } from '../../shared/meta/meta.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { GLOBAL_FLAGS } from './commands/command.ts';
import type { PipelineContext } from './commands/pipeline-options.ts';
import { commandNamed } from './commands/registry.ts';
import { commandHelpText, helpText } from './help.ts';
import { commandNameOf, parseInvocation } from './parse-invocation.ts';
import { render } from './render.ts';
import type { CliData, CliOutcome, OutputFormat } from './render.ts';

export type { CliOutcome } from './render.ts';

export interface CliContext extends PipelineContext {
	readonly version: string;
}

/**
 * Runs one invocation. It never writes to a stream and never exits, so the
 * entry point owns all process side effects and tests assert exact bytes.
 */
export async function runCli(argv: readonly string[], context: CliContext): Promise<CliOutcome> {
	return render(await execute(argv, context), formatOf(argv));
}

/**
 * Read the output format straight off argv rather than from the parsed flags:
 * a request for JSON must be honoured even when the parse itself is what
 * failed, otherwise `docket --typo --json` answers a machine in prose.
 */
function formatOf(argv: readonly string[]): OutputFormat {
	return argv.includes('--json') ? 'json' : 'text';
}

/**
 * Which command was asked for decides which options exist, so the name is read
 * first and the rest of argv is parsed by that command's own flag table.
 */
async function execute(
	argv: readonly string[],
	context: CliContext,
): Promise<Result<CliData, DocketError>> {
	const name = commandNameOf(argv);
	// A bare invocation is not a mistake; it is someone looking for the help.
	if (name === undefined) {
		const globals = parseInvocation(argv, GLOBAL_FLAGS, undefined);
		if (!globals.ok) return globals;

		return globals.value['version'] === true
			? versionOf(context)
			: ok({ kind: 'help', usage: helpText() });
	}

	const command = commandNamed(name);
	if (command === undefined) {
		return err(docketError(ErrorCode.unknownCommand, `unknown command: ${name}`));
	}

	// The global flags are merged last, so no command can redefine one.
	const parsed = parseInvocation(argv, { ...command.flags, ...GLOBAL_FLAGS }, command.name);
	if (!parsed.ok) return parsed;

	if (parsed.value['help'] === true) return ok({ kind: 'help', usage: commandHelpText(command) });
	if (parsed.value['version'] === true) return versionOf(context);

	return command.run(parsed.value, context);
}

function versionOf(context: CliContext): Result<CliData, DocketError> {
	return ok({ kind: 'version', name: PRODUCT_NAME, version: context.version });
}
