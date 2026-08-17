import { docketError, ErrorCode } from '../../../../shared/result/docket-error.ts';
import { err, ok } from '../../../../shared/result/result.ts';
import { publishStepCheck, publishValidationCheck } from '../../../github/checks.ts';
import { readValidationRun } from '../../../run/read-artifacts.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import { absolutePath } from '../paths.ts';
import { githubClientOf } from '../pipeline-options.ts';

const flags = flagsFor(
	'repository',
	'validated-run',
	'workflow-run-id',
	'details-url',
	'github-token',
);

/**
 * `docket publish-check` — turn a recorded verdict into the merge gate.
 *
 * The verdict is read back from the artifacts rather than passed as a flag, so
 * the check can only ever say what the run actually recorded.
 */
export const publishCheckCommand = defineCommand({
	name: 'publish-check',
	summary: 'Publish the recorded verdict as the required GitHub check',
	flags,
	run: async (options, context) => {
		const repository = requiredOption(options.repository, '--repository');
		if (!repository.ok) return repository;

		const directory = requiredOption(options['validated-run'], '--validated-run');
		if (!directory.ok) return directory;

		const workflowRunId = requiredOption(options['workflow-run-id'], '--workflow-run-id');
		if (!workflowRunId.ok) return workflowRunId;

		const run = await readRunRecord(absolutePath(directory.value, context.cwd));
		if (!run.ok) return run;
		if (run.value.workflow?.runId !== workflowRunId.value) {
			return err(
				docketError(
					ErrorCode.planMismatch,
					'refusing to publish: the validation artifact does not belong to this workflow run',
				),
			);
		}

		const client = githubClientOf(options, context);
		if (!client.ok) return client;

		const published = await publishValidationCheck(client.value, {
			repository: repository.value,
			headSha: run.value.plan.source.headSha,
			verdict: run.value.status,
			planIdentity: run.value.plan.identity,
			workflowRunId: workflowRunId.value,
			summary: summarize(run.value),
			...(options['details-url'] === undefined ? {} : { detailsUrl: options['details-url'] }),
		});
		if (!published.ok) return published;

		// Each manual step gets its own required check, so the Merge button stays
		// disabled until someone records that they carried it out (§5 Phase C.7).
		for (const step of run.value.steps) {
			if (!step.manual || step.status === 'passed') continue;

			const stepCheck = await publishStepCheck(client.value, {
				repository: repository.value,
				headSha: run.value.plan.source.headSha,
				step: step.name,
				planIdentity: run.value.plan.identity,
				validationWorkflowRunId: workflowRunId.value,
				...(options['details-url'] === undefined ? {} : { detailsUrl: options['details-url'] }),
			});
			if (!stepCheck.ok) return stepCheck;
		}

		return ok({ kind: 'check', check: published.value });
	},
});

/**
 * The verdict, and its reasons, in the space a check summary gets. Whoever is
 * looking at a blocked Merge button needs to read why here.
 */
function summarize(run: { status: string; validation: { failures: readonly string[] } | null }): string {
	const failures = run.validation?.failures ?? [];
	if (failures.length === 0) return `Docket validation ${run.status}.`;

	return [`Docket validation ${run.status}:`, ...failures.map((failure) => `- ${failure}`)].join('\n');
}

/** Reads the run record without the deployment-time manifest verification. */
async function readRunRecord(directory: string) {
	const run = await readValidationRun(directory);
	return run.ok
		? ok({
				plan: run.value.plan,
				status: run.value.validation.verdict,
				validation: run.value.validation,
				steps: run.value.run.steps,
				workflow: run.value.run.workflow,
			})
		: run;
}
