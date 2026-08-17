import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runCli } from '../lib/features/cli/cli.ts';
import { ExitCode } from '../lib/features/cli/exit-code.ts';
import { createFakeGitHub } from '../lib/features/github/testing/fake-github.ts';
import { failedDeployment, orgDisplay } from '../lib/features/salesforce/testing/fake-sf.ts';
import type { FakeSfBehaviour } from '../lib/features/salesforce/testing/fake-sf.ts';
import { githubContext, pipelineFixtures } from './testing/pipeline-fixture.ts';

const { setUp } = pipelineFixtures();

const TOKEN = { GITHUB_TOKEN: 'a-scoped-token' };

describe('the merge gate', () => {
	async function validatedRun(behaviour?: FakeSfBehaviour) {
		const setup = await setUp(behaviour === undefined ? {} : { behaviour });
		await runCli(
			[
				'validate',
				...setup.validation,
				'--out',
				setup.validated,
				'--workflow-run-id',
				'123456',
				'--workflow-run-attempt',
				'1',
				'--json',
			],
			setup.context,
		);
		return setup;
	}

	test('a passed run publishes a green check that names its workflow run', async () => {
		const { context, validated, repository } = await validatedRun();
		const github = createFakeGitHub({
			'POST /repos/acme/salesforce/check-runs': (request) => ({
				status: 201,
				body: { id: 7, name: 'docket/validate', head_sha: 'x', conclusion: 'success', ...(request.body as object) },
			}),
		});

		const outcome = await runCli(
			[
				'publish-check',
				'--repository',
				'acme/salesforce',
				'--validated-run',
				validated,
				'--workflow-run-id',
				'123456',
				'--json',
			],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		expect(outcome.exitCode).toBe(ExitCode.success);
		const posted = github.requests()[0]?.body as Record<string, unknown>;
		expect(posted['name']).toBe('docket/validate');
		expect(posted['conclusion']).toBe('success');
		expect(posted['head_sha']).toBe(repository.headSha);
		expect(JSON.parse(String(posted['external_id']))).toEqual({
			workflowRunId: '123456',
			planIdentity: JSON.parse(await readFile(join(validated, 'plan.json'), 'utf8')).identity,
		});
	});

	test('a failed run publishes a red check, with the reasons in it', async () => {
		const { context, validated } = await validatedRun({
			responses: [
				{ when: ['org', 'display'], stdout: orgDisplay() },
				{ when: ['deploy', 'validate'], stdout: failedDeployment(), exitCode: 1 },
			],
		});
		const github = createFakeGitHub({
			'POST /repos/acme/salesforce/check-runs': { status: 201, body: { id: 8, conclusion: 'failure' } },
		});

		await runCli(
			[
				'publish-check',
				'--repository',
				'acme/salesforce',
				'--validated-run',
				validated,
				'--workflow-run-id',
				'123456',
			],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		const posted = github.requests()[0]?.body as Record<string, any>;
		expect(posted['conclusion']).toBe('failure');
		expect(posted['output'].summary).toContain('Variable does not exist');
	});

	test('a different workflow run cannot publish the artifact verdict', async () => {
		const { context, validated } = await validatedRun();
		const github = createFakeGitHub({
			'POST /repos/acme/salesforce/check-runs': { status: 201, body: { id: 8 } },
		});

		const outcome = await runCli(
			[
				'publish-check',
				'--repository', 'acme/salesforce',
				'--validated-run', validated,
				'--workflow-run-id', '999999',
				'--json',
			],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(github.requests()).toEqual([]);
	});

	test('a tampered successful run cannot use the failed-run path to publish green', async () => {
		const { context, validated } = await validatedRun();
		await writeFile(join(validated, 'package.xml'), '<Package/>', 'utf8');
		const github = createFakeGitHub({
			'POST /repos/acme/salesforce/check-runs': { status: 201, body: { id: 8, conclusion: 'success' } },
		});

		const outcome = await runCli(
			[
				'publish-check',
				'--repository', 'acme/salesforce',
				'--validated-run', validated,
				'--workflow-run-id', '123456',
				'--json',
			],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(github.requests()).toEqual([]);
	});

	test('the deployment finds the exact run behind the green check', async () => {
		const { context, repository } = await setUp();
		const github = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${repository.headSha}/check-runs`]: {
				status: 200,
				body: {
					check_runs: [
						{
							conclusion: 'success',
							external_id: JSON.stringify({
								workflowRunId: '99',
								planIdentity: `sha256:${'a'.repeat(64)}`,
							}),
						},
					],
				},
			},
		});

		const outcome = await runCli(
			['locate-run', '--repository', 'acme/salesforce', '--head', repository.headSha],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		expect(outcome.stdout).toBe('99\n');
	});

	test('a red or missing check locates nothing', async () => {
		const { context, repository } = await setUp();
		const red = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${repository.headSha}/check-runs`]: {
				status: 200,
				body: {
					check_runs: [
						{
							conclusion: 'failure',
							external_id: JSON.stringify({
								workflowRunId: '99',
								planIdentity: `sha256:${'a'.repeat(64)}`,
							}),
						},
					],
				},
			},
		});

		const failed = await runCli(
			['locate-run', '--repository', 'acme/salesforce', '--head', repository.headSha, '--json'],
			{ ...context, env: TOKEN, ...githubContext(red) },
		);

		expect(JSON.parse(failed.stdout).error.code).toBe('validation_not_passed');

		const absent = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${repository.headSha}/check-runs`]: {
				status: 200,
				body: { check_runs: [] },
			},
		});

		const missing = await runCli(
			['locate-run', '--repository', 'acme/salesforce', '--head', repository.headSha, '--json'],
			{ ...context, env: TOKEN, ...githubContext(absent) },
		);

		expect(JSON.parse(missing.stdout).error.code).toBe('validation_not_passed');
	});
});
