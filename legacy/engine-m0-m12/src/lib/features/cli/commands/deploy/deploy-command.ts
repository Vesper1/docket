import { isAbsolute, join } from 'node:path';

import { ErrorCode } from '../../../../shared/result/docket-error.ts';
import { ok } from '../../../../shared/result/result.ts';
import { parseCommitSha } from '../../../git/commit-sha.ts';
import { deployRun } from '../../../pipeline/deploy-run.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import {
	artifactsExpireAtOf,
	executionOf,
	expectedPlanIdentityOf,
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
	'validated-run',
	'expected-plan-identity',
	'steps',
	'merge-commit',
	'require-merged',
	'sf',
	'wait',
	'out',
	'workflow-run-id',
	'workflow-run-attempt',
	'artifacts-expire-at',
	'github-token',
);

/**
 * `docket deploy` — Phase D from an already-validated run.
 *
 * It takes a directory of validation artifacts rather than a fresh set of
 * refs, because the whole point of the step is that nothing is recomputed: a
 * deployment either matches the validated plan exactly or does not happen.
 */
export const deployCommand = defineCommand({
	name: 'deploy',
	summary: 'Deploy a plan that has already been validated',
	flags,
	run: async (options, context) => {
		const validated = requiredOption(options['validated-run'], '--validated-run');
		if (!validated.ok) return validated;

		const waitMinutes = waitMinutesOf(options);
		if (!waitMinutes.ok) return waitMinutes;
		const execution = executionOf(options);
		if (!execution.ok) return execution;
		const expectedPlanIdentity = expectedPlanIdentityOf(options);
		if (!expectedPlanIdentity.ok) return expectedPlanIdentity;
		const artifactsExpireAt = artifactsExpireAtOf(options);
		if (!artifactsExpireAt.ok) return artifactsExpireAt;

		const repositoryDirectory = repositoryDirectoryOf(options, context.cwd);
		const outputDirectory = outputDirectoryOf(options, context.cwd, 'deploy');
		const startedAt = context.now().toISOString();

		// §5 Phase D.5: the merge is re-read from GitHub at deployment time, not
		// taken from the event that triggered the workflow. A pull request that was
		// closed without merging produces no deployment.
		let mergeCommit: string | undefined;
		if (options['merge-commit'] !== undefined) {
			const parsed = parseCommitSha(
				options['merge-commit'],
				'--merge-commit',
				ErrorCode.invalidOption,
			);
			if (!parsed.ok) return parsed;
			mergeCommit = parsed.value;
		}
		let expectedHeadSha: string | undefined;
		if (options['require-merged'] === true) {
			const merged = await resolveSource(options, context, 'merged');
			if (!merged.ok) return merged;

			mergeCommit = merged.value.pullRequest?.mergeCommitSha ?? mergeCommit;
			expectedHeadSha = merged.value.source.headSha;
		}

		const run = await deployRun({
			validatedDirectory: isAbsolute(validated.value)
				? validated.value
				: join(context.cwd, validated.value),
			repositoryDirectory,
			outputDirectory,
			cli: { executable: sfExecutableOf(options), timeoutMs: timeoutMsOf(waitMinutes.value) },
			waitMinutes: waitMinutes.value,
			executor: execution.value.executor,
			timing: { startedAt, finishedAt: context.now().toISOString() },
			...(execution.value.workflow === undefined ? {} : { workflow: execution.value.workflow }),
			...(expectedPlanIdentity.value === undefined
				? {}
				: { expectedPlanIdentity: expectedPlanIdentity.value }),
			...(options.steps === undefined
				? {}
				: {
						completionsDirectory: isAbsolute(options.steps)
							? options.steps
							: join(context.cwd, options.steps),
					}),
			...(mergeCommit === undefined ? {} : { mergeCommit }),
			...(expectedHeadSha === undefined ? {} : { expectedHeadSha }),
			...(artifactsExpireAt.value === undefined
				? {}
				: { artifactsExpireAt: artifactsExpireAt.value }),
		});
		if (!run.ok) return run;

		return ok({ kind: 'run', run: run.value, directory: outputDirectory });
	},
});
