import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { Verdict } from '../validation/validation-record.ts';
import { githubRequest } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';

/**
 * The check name is a contract with the repository's branch protection: it is
 * what an administrator types into "required status checks", so it must not
 * change once a repository depends on it.
 */
export const VALIDATION_CHECK_NAME = 'docket/validate';
export const STEP_CHECK_SCHEMA = 'docket.step-check/v1';

export interface PublishCheckRequest {
	readonly repository: string;
	/** The head commit the verdict is about. A check belongs to one commit. */
	readonly headSha: string;
	readonly verdict: Verdict;
	/** The identity of the plan this verdict approved. */
	readonly planIdentity: string;
	/** The workflow run that produced the validation artifacts. */
	readonly workflowRunId: string;
	readonly summary: string;
	readonly detailsUrl?: string;
}

/** What a published check says, once GitHub has accepted it. */
export interface PublishedCheck {
	readonly id: number;
	readonly name: string;
	readonly headSha: string;
	readonly conclusion: string;
	readonly externalId: string;
}

/**
 * Publishes the validation verdict as a required check for one commit.
 *
 * The check is the merge gate (§4): nothing else in GitHub can block the Merge
 * button. Because a check belongs to a single commit, a new push has no check
 * of its own and the gate closes again by itself — which is exactly the
 * staleness rule of §5 Phase C.9.
 */
export async function publishValidationCheck(
	client: GitHubClient,
	request: PublishCheckRequest,
): Promise<Result<PublishedCheck, DocketError>> {
	const externalId = encodeExternalId(request.workflowRunId, request.planIdentity);

	const response = await githubRequest(client, {
		method: 'POST',
		path: `/repos/${request.repository}/check-runs`,
		body: {
			name: VALIDATION_CHECK_NAME,
			head_sha: request.headSha,
			status: 'completed',
			conclusion: request.verdict === 'passed' ? 'success' : 'failure',
			external_id: externalId,
			...(request.detailsUrl === undefined ? {} : { details_url: request.detailsUrl }),
			output: {
				title: request.verdict === 'passed' ? 'Validation passed' : 'Validation failed',
				summary: request.summary,
			},
		},
	});
	if (!response.ok) return response;

	const body = asRecord(response.value.body);
	const id = typeof body?.['id'] === 'number' ? body['id'] : undefined;
	if (id === undefined) {
		return err(docketError(ErrorCode.githubFailed, 'GitHub accepted no check run'));
	}

	return ok({
		id,
		name: text(body?.['name']) ?? VALIDATION_CHECK_NAME,
		headSha: text(body?.['head_sha']) ?? request.headSha,
		conclusion: text(body?.['conclusion']) ?? '',
		externalId,
	});
}

/**
 * A required check for one manual step.
 *
 * It exists so the Merge button stays disabled until a person records that
 * they did the thing: an in-progress check is not a success, and GitHub will
 * not merge past a required check that has not concluded.
 *
 * Re-running validation for the same head publishes a new pending check, which
 * re-blocks a step someone had already completed. That is deliberate: the run
 * that would deploy is the new one, and its manual step has not been carried
 * out against it.
 */
export async function publishStepCheck(
	client: GitHubClient,
	request: {
		readonly repository: string;
			readonly headSha: string;
			readonly step: string;
			readonly planIdentity: string;
			readonly validationWorkflowRunId: string;
			readonly detailsUrl?: string;
		},
): Promise<Result<PublishedCheck, DocketError>> {
	const externalId = encodeStepCheck({
		schema: STEP_CHECK_SCHEMA,
		step: request.step,
		planIdentity: request.planIdentity,
		validationWorkflowRunId: request.validationWorkflowRunId,
		completionWorkflowRunId: null,
	});

	const response = await githubRequest(client, {
		method: 'POST',
		path: `/repos/${request.repository}/check-runs`,
			body: {
				name: stepCheckName(request.step),
				head_sha: request.headSha,
				status: 'in_progress',
				external_id: externalId,
				...(request.detailsUrl === undefined ? {} : { details_url: request.detailsUrl }),
				output: {
					title: 'Waiting for a person',
					summary: `Manual step \`${request.step}\` has not been completed yet.`,
				},
		},
	});
	if (!response.ok) return response;

	const body = asRecord(response.value.body);
	const id = typeof body?.['id'] === 'number' ? body['id'] : undefined;
	if (id === undefined) {
		return err(docketError(ErrorCode.githubFailed, 'GitHub accepted no manual-step check run'));
	}

	return ok({
		id,
		name: stepCheckName(request.step),
		headSha: request.headSha,
		conclusion: '',
		externalId,
	});
}

/**
 * What a step check carries in `external_id`.
 *
 * Deliberately only the tuple that has to survive a round trip through GitHub:
 * who completed the step and when live in the immutable completion artifact,
 * which is the evidence, while `external_id` is capped and only has to identify
 * the check.
 */
export interface StepCheckIdentity {
	readonly schema: typeof STEP_CHECK_SCHEMA;
	readonly step: string;
	readonly planIdentity: string;
	readonly validationWorkflowRunId: string;
	readonly completionWorkflowRunId: string | null;
}

/** Completes the exact pending check created for this plan; never creates a look-alike. */
export async function completeStepCheck(
	client: GitHubClient,
	request: {
		readonly repository: string;
		readonly headSha: string;
		readonly step: string;
		readonly planIdentity: string;
		readonly completionWorkflowRunId: string;
		readonly completedBy: string;
		readonly detailsUrl?: string;
	},
): Promise<Result<PublishedCheck, DocketError>> {
	const pending = await matchingStepCheck(client, request.repository, request.headSha, request.step, (identity) =>
		identity.planIdentity === request.planIdentity && identity.completionWorkflowRunId === null,
	);
	if (!pending.ok) return pending;

	const identity: StepCheckIdentity = {
		...pending.value.identity,
		completionWorkflowRunId: request.completionWorkflowRunId,
	};
	const externalId = encodeStepCheck(identity);
	const response = await githubRequest(client, {
		method: 'PATCH',
		path: `/repos/${request.repository}/check-runs/${pending.value.id}`,
		body: {
			status: 'completed',
			conclusion: 'success',
			external_id: externalId,
			...(request.detailsUrl === undefined ? {} : { details_url: request.detailsUrl }),
			output: {
				title: `Completed by ${request.completedBy}`,
				summary: `Manual step \`${request.step}\` was completed by ${request.completedBy}.`,
			},
		},
	});
	if (!response.ok) return response;

	return ok({
		id: pending.value.id,
		name: stepCheckName(request.step),
		headSha: request.headSha,
		conclusion: 'success',
		externalId,
	});
}

export interface StepCompletionOrigin {
	readonly step: string;
	readonly workflowRunId: string;
}

/** Finds immutable completion artifacts behind all successful manual checks. */
export async function findStepCompletionRuns(
	client: GitHubClient,
	request: {
		readonly repository: string;
		readonly headSha: string;
		readonly planIdentity: string;
		readonly steps: readonly string[];
	},
): Promise<Result<readonly StepCompletionOrigin[], DocketError>> {
	const origins: StepCompletionOrigin[] = [];
	for (const step of request.steps) {
		const completed = await matchingStepCheck(
			client,
			request.repository,
			request.headSha,
			step,
			(identity, check) =>
				identity.planIdentity === request.planIdentity &&
				identity.completionWorkflowRunId !== null &&
				check['conclusion'] === 'success',
		);
		if (!completed.ok) return completed;

		const workflowRunId = completed.value.identity.completionWorkflowRunId;
		if (workflowRunId === null) {
			return err(docketError(ErrorCode.stepIncomplete, `manual step \`${step}\` is not completed`));
		}
		origins.push({ step, workflowRunId });
	}

	return ok(origins);
}

/** One check per manual step, so each blocks the merge on its own. */
export function stepCheckName(step: string): string {
	return `docket/step/${step}`;
}

/** The validation run a green check points back to. */
export interface OriginatingRun {
	readonly workflowRunId: string;
	readonly planIdentity: string;
}

/**
 * Finds the workflow run whose validation produced the green check.
 *
 * §5 Phase D.4: the deployment fetches the artifacts of that exact run, not of
 * "the latest validation". Anything else would let a second, unrelated run
 * supply the plan that gets deployed.
 */
export async function findOriginatingRun(
	client: GitHubClient,
	repository: string,
	headSha: string,
): Promise<Result<OriginatingRun, DocketError>> {
	const response = await githubRequest(client, {
		method: 'GET',
		path: `/repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(VALIDATION_CHECK_NAME)}&filter=latest&per_page=100`,
	});
	if (!response.ok) return response;

	const raw = asRecord(response.value.body)?.['check_runs'];
	const checks = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
		const check = asRecord(entry);
		return check === undefined ? [] : [check];
	});
	if (checks.length === 0) {
		return err(
			docketError(
				ErrorCode.validationNotPassed,
				`no ${VALIDATION_CHECK_NAME} check exists for ${headSha}`,
			),
		);
	}

	// `filter=latest` returns the newest check of this name *per app*, so the
	// list can hold a look-alike published by something other than Docket.
	// Docket's own check is the one whose `external_id` decodes, and picking by
	// index rather than by that would let a third party choose the plan.
	const ours = checks.filter((check) => decodeExternalId(text(check['external_id'])) !== undefined);
	if (ours.length === 0) {
		return err(
			docketError(
				ErrorCode.githubFailed,
				`no ${VALIDATION_CHECK_NAME} check for ${headSha} names its workflow run`,
			),
		);
	}

	const passed = ours.find((check) => text(check['conclusion']) === 'success');
	if (passed === undefined) {
		return err(
			docketError(
				ErrorCode.validationNotPassed,
				`the ${VALIDATION_CHECK_NAME} check for ${headSha} concluded ${text(ours[0]?.['conclusion']) ?? 'nothing'}`,
			),
		);
	}

	const decoded = decodeExternalId(text(passed['external_id']));
	if (decoded === undefined) {
		return err(
			docketError(
				ErrorCode.githubFailed,
				`the ${VALIDATION_CHECK_NAME} check for ${headSha} does not name its workflow run`,
			),
		);
	}

	return ok(decoded);
}

/**
 * The check carries the run id and the plan identity in `external_id`, the one
 * field GitHub keeps verbatim and hands back on read.
 */
function encodeExternalId(workflowRunId: string, planIdentity: string): string {
	return JSON.stringify({ workflowRunId, planIdentity });
}

function decodeExternalId(value: string | undefined): OriginatingRun | undefined {
	if (value === undefined) return undefined;

	try {
		const parsed = asRecord(JSON.parse(value));
		const workflowRunId = text(parsed?.['workflowRunId']);
		const planIdentity = text(parsed?.['planIdentity']);
		return (
			workflowRunId === undefined ||
			!/^[1-9][0-9]*$/.test(workflowRunId) ||
			planIdentity === undefined ||
			!/^sha256:[0-9a-f]{64}$/.test(planIdentity)
		)
			? undefined
			: { workflowRunId, planIdentity };
	} catch {
		return undefined;
	}
}

async function matchingStepCheck(
	client: GitHubClient,
	repository: string,
	headSha: string,
	step: string,
	predicate: (identity: StepCheckIdentity, check: Record<string, unknown>) => boolean,
): Promise<Result<{ readonly id: number; readonly identity: StepCheckIdentity }, DocketError>> {
	const response = await githubRequest(client, {
		method: 'GET',
		path: `/repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(stepCheckName(step))}&filter=latest&per_page=100`,
	});
	if (!response.ok) return response;

	const checks = asRecord(response.value.body)?.['check_runs'];
	for (const raw of Array.isArray(checks) ? checks : []) {
		const check = asRecord(raw);
		const id = typeof check?.['id'] === 'number' ? check['id'] : undefined;
		const identity = decodeStepCheck(text(check?.['external_id']));
		if (id !== undefined && identity?.step === step && predicate(identity, check ?? {})) {
			return ok({ id, identity });
		}
	}

	return err(
		docketError(
			ErrorCode.stepIncomplete,
			`no matching ${stepCheckName(step)} check exists for ${headSha}`,
		),
	);
}

function encodeStepCheck(identity: StepCheckIdentity): string {
	// `external_id` is intentionally compact: GitHub caps integrator identifiers,
	// while the full field names remain part of Docket's in-memory API.
	return JSON.stringify({
		v: 1,
		s: identity.step,
		p: identity.planIdentity,
		vr: identity.validationWorkflowRunId,
		cr: identity.completionWorkflowRunId,
	});
}

function decodeStepCheck(value: string | undefined): StepCheckIdentity | undefined {
	if (value === undefined) return undefined;

	try {
		const record = asRecord(JSON.parse(value));
		if (
			record?.['v'] !== 1 ||
			text(record['s']) === undefined ||
			text(record['p']) === undefined ||
			text(record['vr']) === undefined ||
			!(record['cr'] === null || text(record['cr']))
		) {
			return undefined;
		}

		return {
			schema: STEP_CHECK_SCHEMA,
			step: record['s'] as string,
			planIdentity: record['p'] as string,
			validationWorkflowRunId: record['vr'] as string,
			completionWorkflowRunId: record['cr'] as string | null,
		};
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}
