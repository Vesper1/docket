import { isAbsolute, join } from 'node:path';

import { docketError, ErrorCode } from '../../../shared/result/docket-error.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { err, ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import { completeStepCheck } from '../../github/checks.ts';
import type { GitHubClient } from '../../github/github-client.ts';
import { readValidatedRun } from '../../run/read-artifacts.ts';
import {
	completionPath,
	readCompletions,
	recordCompletion,
	STEP_COMPLETION_SCHEMA,
} from '../../steps/step-completion.ts';
import type { StepCompletion } from '../../steps/step-completion.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import { githubClientOf } from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

/**
 * `docket complete-step` — a person states that a manual step is done.
 *
 * This is the only way a manual step is ever completed: an explicit action
 * that writes an immutable record naming the step, the exact plan, the person
 * and the time, and then turns the step's required check green.
 */
export async function completeStepCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const directory = requiredOption(options['validated-run'], '--validated-run');
	if (!directory.ok) return directory;

	const step = requiredOption(options.step, '--step');
	if (!step.ok) return step;

	const by = requiredOption(options.by, '--by');
	if (!by.ok) return by;

	const steps = requiredOption(options.steps, '--steps');
	if (!steps.ok) return steps;
	const completionWorkflowRunId = options['workflow-run-id'] ?? null;
	if (completionWorkflowRunId !== null && !/^[1-9][0-9]*$/.test(completionWorkflowRunId)) {
		return err(
			docketError(ErrorCode.invalidOption, '--workflow-run-id must be a positive whole number'),
		);
	}

	let publishing:
		| { readonly repository: string; readonly workflowRunId: string; readonly client: GitHubClient }
		| undefined;
	if (options.repository !== undefined) {
		const workflowRunId = requiredOption(
			completionWorkflowRunId ?? undefined,
			'--workflow-run-id',
		);
		if (!workflowRunId.ok) return workflowRunId;

		const client = githubClientOf(options, context);
		if (!client.ok) return client;
		publishing = { repository: options.repository, workflowRunId: workflowRunId.value, client: client.value };
	}

	const validated = await readValidatedRun(absolute(directory.value, context.cwd));
	if (!validated.ok) return validated;

	const plan = validated.value.plan;
	const known = plan.steps.preDeployment.some(
		(candidate) => candidate.kind === 'manual' && candidate.name === step.value,
	);
	if (!known) {
		return err(
			docketError(
				ErrorCode.stepIncomplete,
				`this plan has no manual pre-deployment step named \`${step.value}\``,
			),
		);
	}

	let completion: StepCompletion = {
		schema: STEP_COMPLETION_SCHEMA,
		step: step.value,
		planIdentity: plan.identity,
		headSha: plan.source.headSha,
		completedBy: by.value,
		completedAt: context.now().toISOString(),
		workflowRunId: completionWorkflowRunId,
	};

	const stepsDirectory = absolute(steps.value, context.cwd);
	let recorded = await recordCompletion(stepsDirectory, completion);
	if (!recorded.ok && recorded.error.code === ErrorCode.stepAlreadyCompleted && options.repository !== undefined) {
		const existing = await readCompletions(stepsDirectory);
		if (!existing.ok) return existing;
		const same = existing.value.find(
			(candidate) =>
				candidate.step === completion.step &&
				candidate.planIdentity === completion.planIdentity &&
				candidate.headSha === completion.headSha &&
				candidate.completedBy === completion.completedBy &&
				candidate.workflowRunId === completion.workflowRunId,
		);
		if (same !== undefined) {
			completion = same;
			recorded = ok(completionPath(stepsDirectory, same));
		}
	}
	if (!recorded.ok) return recorded;

	// The check is completed only after the record exists, so a green check can
	// never be the only evidence that a step was done.
	if (publishing !== undefined) {
		const published = await completeStepCheck(publishing.client, {
			repository: publishing.repository,
			headSha: plan.source.headSha,
			step: step.value,
			planIdentity: plan.identity,
			completionWorkflowRunId: publishing.workflowRunId,
			completedBy: by.value,
			...(options['details-url'] === undefined ? {} : { detailsUrl: options['details-url'] }),
		});
		if (!published.ok) return published;
	}

	return ok({ kind: 'step-completed', completion, path: recorded.value });
}

function absolute(path: string, cwd: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}
