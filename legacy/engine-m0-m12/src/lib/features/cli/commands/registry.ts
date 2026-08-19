import { changesCommand } from './changes/changes-command.ts';
import type { Command } from './command.ts';
import { completeStepCommand } from './complete-step/complete-step-command.ts';
import { deployCommand } from './deploy/deploy-command.ts';
import { gatesCommand } from './gates/gates-command.ts';
import { historyCommand } from './history/history-command.ts';
import { inspectRunCommand } from './inspect-run/inspect-run-command.ts';
import { locateRunCommand } from './locate-run/locate-run-command.ts';
import { locateStepsCommand } from './locate-steps/locate-steps-command.ts';
import { planCommand } from './plan/plan-command.ts';
import { publishCheckCommand } from './publish-check/publish-check-command.ts';
import { rollbackCommand } from './rollback/rollback-command.ts';
import { stateAuditCommand } from './state-audit/state-audit-command.ts';
import { validateCommand } from './validate/validate-command.ts';

/**
 * Every command Docket has, in the order the help prints them: the pipeline
 * from a diff to a deployment first, then the commands a workflow calls around
 * it, then the ones for looking backwards.
 */
export const COMMANDS: readonly Command[] = [
	changesCommand,
	planCommand,
	gatesCommand,
	validateCommand,
	deployCommand,
	publishCheckCommand,
	locateRunCommand,
	locateStepsCommand,
	completeStepCommand,
	inspectRunCommand,
	rollbackCommand,
	historyCommand,
	stateAuditCommand,
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export const commandNamed = (name: string): Command | undefined => BY_NAME.get(name);
