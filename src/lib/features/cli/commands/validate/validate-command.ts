import { isAbsolute, join } from 'node:path';

import { ok } from '../../../../shared/result/result.ts';
import { readPassedGateRun } from '../../../pipeline/gate-run.ts';
import { prepareRun } from '../../../pipeline/prepare.ts';
import { validateRun } from '../../../pipeline/validate-run.ts';
import type { StepRunOutcome } from '../../../steps/run-steps.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import {
	artifactsExpireAtOf,
	executionOf,
	orgResolverOf,
	outputDirectoryOf,
	repositoryDirectoryOf,
	resolveSource,
	sfExecutableOf,
	timeoutMsOf,
	waitMinutesOf,
} from '../pipeline-options.ts';

const flags = flagsFor(
	'repo',
	'repository',
	'pull-request',
	'base',
	'head',
	'environment',
	'target-branch',
	'org-id',
	'sf',
	'wait',
	'gates-run',
	'out',
	'workflow-run-id',
	'workflow-run-attempt',
	'artifacts-expire-at',
	'github-token',
);

/**
 * `docket validate` — Phase C locally, against the configured QA org.
 *
 * It writes the same artifacts a workflow writes, so a local validation and a
 * GitHub one are the same run in two places, and the deployment that follows
 * cannot tell them apart.
 */
export const validateCommand = defineCommand({
	name: 'validate',
	summary: 'Validate that plan against the configured org',
	flags,
	run: async (options, context) => {
		const source = await resolveSource(options, context);
		if (!source.ok) return source;

		const environment = requiredOption(options.environment, '--environment');
		if (!environment.ok) return environment;

		const waitMinutes = waitMinutesOf(options);
		if (!waitMinutes.ok) return waitMinutes;
		const execution = executionOf(options);
		if (!execution.ok) return execution;
		const artifactsExpireAt = artifactsExpireAtOf(options);
		if (!artifactsExpireAt.ok) return artifactsExpireAt;

		const repositoryDirectory = repositoryDirectoryOf(options, context.cwd);
		const startedAt = context.now().toISOString();

		const prepared = await prepareRun(
			{
				repositoryDirectory,
				source: source.value.source,
				environmentId: environment.value,
				targetBranch: source.value.targetBranch,
			},
			orgResolverOf(options, repositoryDirectory),
		);
		if (!prepared.ok) return prepared;

		let gates: StepRunOutcome = { results: [], logs: [] };
		if (prepared.value.environment.gates.length > 0 || options['gates-run'] !== undefined) {
			const directory = requiredOption(options['gates-run'], '--gates-run');
			if (!directory.ok) return directory;

			const verified = await readPassedGateRun(
				isAbsolute(directory.value) ? directory.value : join(context.cwd, directory.value),
				{
					source: source.value.source,
					environment: prepared.value.environment,
					targetBranch: source.value.targetBranch ?? prepared.value.environment.branch,
				},
			);
			if (!verified.ok) return verified;
			gates = verified.value;
		}

		const run = await validateRun({
			prepared: prepared.value,
			repositoryDirectory,
			outputDirectory: outputDirectoryOf(options, context.cwd, 'validate'),
			cli: { executable: sfExecutableOf(options), timeoutMs: timeoutMsOf(waitMinutes.value) },
			waitMinutes: waitMinutes.value,
			executor: execution.value.executor,
			timing: { startedAt, finishedAt: context.now().toISOString() },
			gates,
			...(execution.value.workflow === undefined ? {} : { workflow: execution.value.workflow }),
			...(artifactsExpireAt.value === undefined
				? {}
				: { artifactsExpireAt: artifactsExpireAt.value }),
		});
		if (!run.ok) return run;

		return ok({
			kind: 'run',
			run: run.value,
			directory: outputDirectoryOf(options, context.cwd, 'validate'),
		});
	},
});
