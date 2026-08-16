import { isAbsolute, join } from 'node:path';

import type { DocketError } from '../../../shared/result/docket-error.ts';
import { docketError, ErrorCode } from '../../../shared/result/docket-error.ts';
import { err, ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import {
	findOriginatingRun,
	findStepCompletionRuns,
	publishStepCheck,
	publishValidationCheck,
} from '../../github/checks.ts';
import { parseCommitSha } from '../../git/commit-sha.ts';
import { readValidatedRun, readValidationRun } from '../../run/read-artifacts.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import { githubClientOf } from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

/**
 * `docket publish-check` — turn a recorded verdict into the merge gate.
 *
 * The verdict is read back from the artifacts rather than passed as a flag, so
 * the check can only ever say what the run actually recorded.
 */
export async function publishCheckCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const repository = requiredOption(options.repository, '--repository');
	if (!repository.ok) return repository;

	const directory = requiredOption(options['validated-run'], '--validated-run');
	if (!directory.ok) return directory;

	const workflowRunId = requiredOption(options['workflow-run-id'], '--workflow-run-id');
	if (!workflowRunId.ok) return workflowRunId;

	const run = await readRunRecord(absolute(directory.value, context.cwd));
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
}

/**
 * `docket locate-run` — find the validation run a green check points at.
 *
 * The post-merge workflow calls this before it downloads anything: the run id
 * it gets back is the only one whose artifacts may be deployed.
 */
export async function locateRunCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const repository = requiredOption(options.repository, '--repository');
	if (!repository.ok) return repository;

	const head = requiredOption(options.head, '--head');
	if (!head.ok) return head;
	const headSha = parseCommitSha(head.value, '--head', ErrorCode.invalidOption);
	if (!headSha.ok) return headSha;

	const client = githubClientOf(options, context);
	if (!client.ok) return client;

	const originating = await findOriginatingRun(client.value, repository.value, headSha.value);
	if (!originating.ok) return originating;

	return ok({ kind: 'originating-run', originating: originating.value });
}

/** Locates the immutable workflow artifact for every required manual step. */
export async function locateStepRunsCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const repository = requiredOption(options.repository, '--repository');
	if (!repository.ok) return repository;

	const directory = requiredOption(options['validated-run'], '--validated-run');
	if (!directory.ok) return directory;

	const client = githubClientOf(options, context);
	if (!client.ok) return client;

	const validated = await readValidatedRun(absolute(directory.value, context.cwd));
	if (!validated.ok) return validated;

	const manual = validated.value.plan.steps.preDeployment.flatMap((step) =>
		step.kind === 'manual' ? [step.name] : [],
	);
	const origins = await findStepCompletionRuns(client.value, {
		repository: repository.value,
		headSha: validated.value.plan.source.headSha,
		planIdentity: validated.value.plan.identity,
		steps: manual,
	});
	if (!origins.ok) return origins;

	return ok({ kind: 'step-origins', origins: origins.value });
}

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

function absolute(path: string, cwd: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}
