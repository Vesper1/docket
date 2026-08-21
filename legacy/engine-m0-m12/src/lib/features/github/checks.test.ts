import { describe, expect, test } from 'vitest';

import { isErr, isOk } from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import {
	completeStepCheck,
	publishValidationCheck,
	findOriginatingRun,
	findStepCompletionRuns,
	publishStepCheck,
	stepCheckName,
	VALIDATION_CHECK_NAME,
} from './checks.ts';
import { createFakeGitHub } from './testing/fake-github.ts';

const REPOSITORY = 'acme/salesforce';
const HEAD = 'b'.repeat(40);
const PLAN = `sha256:${'a'.repeat(64)}`;
const STEP = 'release-window';
const LIST = `GET /repos/${REPOSITORY}/commits/${HEAD}/check-runs`;

const client = (fake: ReturnType<typeof createFakeGitHub>) => {
	return { token: 'scoped', baseUrl: fake.baseUrl, fetch: fake.fetch };
};

describe('manual-step checks', () => {
	test('a pending check is bound to the exact plan and validation run', async () => {
		const fake = createFakeGitHub({
			[`POST /repos/${REPOSITORY}/check-runs`]: { status: 201, body: { id: 17 } },
		});

		const published = await publishStepCheck(client(fake), {
			repository: REPOSITORY,
			headSha: HEAD,
			step: STEP,
			planIdentity: PLAN,
			validationWorkflowRunId: '100',
		});

		expect(isOk(published) && published.value.id).toBe(17);
		const body = fake.requests()[0]?.body as Record<string, unknown>;
		expect(body['name']).toBe(stepCheckName(STEP));
		expect(body['status']).toBe('in_progress');
		expect(JSON.parse(String(body['external_id']))).toMatchObject({ p: PLAN, vr: '100', cr: null });
	});

	test('completion patches the matching pending check instead of creating a look-alike', async () => {
		const external = JSON.stringify({ v: 1, s: STEP, p: PLAN, vr: '100', cr: null });
		const fake = createFakeGitHub({
			[LIST]: {
				status: 200,
				body: {
					check_runs: [
						{ id: 8, conclusion: null, external_id: JSON.stringify({ ...JSON.parse(external), p: 'other' }) },
						{ id: 9, conclusion: null, external_id: external },
					],
				},
			},
			[`PATCH /repos/${REPOSITORY}/check-runs/9`]: { status: 200, body: { id: 9 } },
		});

		const completed = await completeStepCheck(client(fake), {
			repository: REPOSITORY,
			headSha: HEAD,
			step: STEP,
			planIdentity: PLAN,
			completionWorkflowRunId: '200',
			completedBy: 'taras',
		});

		expect(isOk(completed) && completed.value.id).toBe(9);
		expect(fake.requests().map((request) => `${request.method} ${request.path}`)).toEqual([
			LIST,
			`PATCH /repos/${REPOSITORY}/check-runs/9`,
		]);
		const body = fake.requests()[1]?.body as Record<string, unknown>;
		expect(body['conclusion']).toBe('success');
		expect(JSON.parse(String(body['external_id']))).toMatchObject({ cr: '200' });
	});

	test('deployment accepts only a successful completion for the same plan', async () => {
		const completed = JSON.stringify({
			v: 1,
			s: STEP,
			p: PLAN,
			vr: '100',
			cr: '200',
		});
		const fake = createFakeGitHub({
			[LIST]: { status: 200, body: { check_runs: [{ id: 9, conclusion: 'success', external_id: completed }] } },
		});

		const origins = await findStepCompletionRuns(client(fake), {
			repository: REPOSITORY,
			headSha: HEAD,
			planIdentity: PLAN,
			steps: [STEP],
		});
		expect(isOk(origins) && origins.value).toEqual([{ step: STEP, workflowRunId: '200' }]);

		const wrongPlan = await findStepCompletionRuns(client(fake), {
			repository: REPOSITORY,
			headSha: HEAD,
			planIdentity: `sha256:${'c'.repeat(64)}`,
			steps: [STEP],
		});
		expect(errorOf(wrongPlan).code).toBe('step_incomplete');
	});
});

describe('the validation check behind a deployment', () => {
	const ORIGIN = JSON.stringify({ workflowRunId: '99', planIdentity: PLAN });

	test(`another app's ${VALIDATION_CHECK_NAME} cannot supply the plan`, async () => {
		const fake = createFakeGitHub({
			[LIST]: {
				status: 200,
				body: {
					check_runs: [
						{ id: 1, conclusion: 'success', external_id: 'from-another-app' },
						{ id: 2, conclusion: 'success', external_id: ORIGIN },
					],
				},
			},
		});

		const found = await findOriginatingRun(client(fake), REPOSITORY, HEAD);
		expect(isOk(found) && found.value).toEqual({ workflowRunId: '99', planIdentity: PLAN });
	});

	test('a look-alike on its own names no run to deploy', async () => {
		const fake = createFakeGitHub({
			[LIST]: {
				status: 200,
				body: { check_runs: [{ id: 1, conclusion: 'success', external_id: 'from-another-app' }] },
			},
		});

		const found = await findOriginatingRun(client(fake), REPOSITORY, HEAD);
		expect(errorOf(found).code).toBe('github_failed');
	});
});

/**
 * A run that dies before it records a verdict has no plan to name. It must
 * still be able to say so, and must never be able to say anything else.
 */
describe('a validation check with no plan behind it', () => {
	test('publishes a failure that carries no identity', async () => {
		const fake = createFakeGitHub({
			[`POST /repos/${REPOSITORY}/check-runs`]: { status: 201, body: { id: 42 } },
		});

		const published = await publishValidationCheck(client(fake), {
			repository: REPOSITORY,
			headSha: HEAD,
			verdict: 'failed',
			planIdentity: null,
			workflowRunId: '100',
			summary: 'the run recorded no verdict',
		});

		expect(isOk(published)).toBe(true);
		const body = fake.requests()[0]?.body as Record<string, unknown>;
		expect(body['name']).toBe(VALIDATION_CHECK_NAME);
		expect(body['conclusion']).toBe('failure');
		// Nothing for a deployment to select: the identity is what it reads.
		expect(body['external_id']).toBeUndefined();
	});

	test('cannot be turned into a passing one', async () => {
		const fake = createFakeGitHub({
			[`POST /repos/${REPOSITORY}/check-runs`]: { status: 201, body: { id: 43 } },
		});

		const published = await publishValidationCheck(client(fake), {
			repository: REPOSITORY,
			headSha: HEAD,
			verdict: 'passed',
			planIdentity: null,
			workflowRunId: '100',
			summary: 'nothing happened, honest',
		});

		expect(isErr(published)).toBe(true);
		expect(fake.requests()).toEqual([]);
	});

	test('is reported as a failed validation, not as a malformed check', async () => {
		const fake = createFakeGitHub({
			[LIST]: {
				status: 200,
				body: { check_runs: [{ id: 44, conclusion: 'failure', external_id: '' }] },
			},
		});

		const found = await findOriginatingRun(client(fake), REPOSITORY, HEAD);

		expect(errorOf(found).code).toBe('validation_not_passed');
	});
});
