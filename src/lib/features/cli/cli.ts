import { parseArgs } from 'node:util';

import { PRODUCT_NAME } from '../../shared/meta/meta.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { changesCommand } from './commands/changes-command.ts';
import {
	locateRunCommand,
	locateStepRunsCommand,
	publishCheckCommand,
} from './commands/check-commands.ts';
import { completeStepCommand } from './commands/complete-step-command.ts';
import { deployCommand } from './commands/deploy-command.ts';
import { gatesCommand } from './commands/gates-command.ts';
import { historyCommand } from './commands/history-command.ts';
import { inspectRunCommand } from './commands/inspect-run-command.ts';
import { planCommand } from './commands/plan-command.ts';
import { rollbackCommand } from './commands/rollback-command.ts';
import { stateAuditCommand } from './commands/state-audit-command.ts';
import { validateCommand } from './commands/validate-command.ts';
import type { PipelineContext } from './commands/pipeline-options.ts';
import { helpText } from './help.ts';
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

async function execute(
	argv: readonly string[],
	context: CliContext,
): Promise<Result<CliData, DocketError>> {
	let parsed: ReturnType<typeof parseArgs<typeof parseOptions>>;
	try {
		parsed = parseArgs({ ...parseOptions, args: [...argv] });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err(docketError(ErrorCode.invalidOption, firstSentence(message)));
	}

	if (parsed.values.help) return ok({ kind: 'help', usage: helpText() });
	if (parsed.values.version) {
		return ok({ kind: 'version', name: PRODUCT_NAME, version: context.version });
	}

	const command = parsed.positionals[0];
	// A bare invocation is not a mistake; it is someone looking for the help.
	if (command === undefined) return ok({ kind: 'help', usage: helpText() });

	switch (command) {
		case 'changes':
			return changesCommand(parsed.values, context);
		case 'plan':
			return planCommand(parsed.values, context);
		case 'gates':
			return gatesCommand(parsed.values, context);
		case 'validate':
			return validateCommand(parsed.values, context);
		case 'deploy':
			return deployCommand(parsed.values, context);
		case 'publish-check':
			return publishCheckCommand(parsed.values, context);
		case 'locate-run':
			return locateRunCommand(parsed.values, context);
		case 'locate-steps':
			return locateStepRunsCommand(parsed.values, context);
		case 'complete-step':
			return completeStepCommand(parsed.values, context);
		case 'inspect-run':
			return inspectRunCommand(parsed.values, context);
		case 'rollback':
			return rollbackCommand(parsed.values, context);
		case 'history':
			return historyCommand(parsed.values, context);
		case 'state-audit':
			return stateAuditCommand();
		default:
			return err(docketError(ErrorCode.unknownCommand, `unknown command: ${command}`));
	}
}

const parseOptions = {
	options: {
		help: { type: 'boolean', short: 'h' },
		version: { type: 'boolean', short: 'v' },
		json: { type: 'boolean' },
		repo: { type: 'string' },
		base: { type: 'string' },
		head: { type: 'string' },
		repository: { type: 'string' },
		'pull-request': { type: 'string' },
		environment: { type: 'string' },
		'target-branch': { type: 'string' },
		'org-id': { type: 'string' },
		out: { type: 'string' },
		sf: { type: 'string' },
		wait: { type: 'string' },
			'validated-run': { type: 'string' },
			'gates-run': { type: 'string' },
		'merge-commit': { type: 'string' },
		'github-token': { type: 'string' },
		'require-merged': { type: 'boolean' },
		'workflow-run-id': { type: 'string' },
		'workflow-run-attempt': { type: 'string' },
		'expected-plan-identity': { type: 'string' },
		'artifacts-expire-at': { type: 'string' },
		'details-url': { type: 'string' },
		steps: { type: 'string' },
		step: { type: 'string' },
			by: { type: 'string' },
			run: { type: 'string' },
		runs: { type: 'string' },
		'create-pr': { type: 'boolean' },
	},
	allowPositionals: true,
	strict: true,
} as const;

/**
 * parseArgs appends a paragraph of advice to its errors. Keep the diagnosis,
 * drop the lecture — our own help line already tells the user where to look.
 */
function firstSentence(message: string): string {
	return message.split('. ')[0] ?? message;
}
