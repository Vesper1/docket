import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runCli } from '../lib/features/cli/cli.ts';
import { ExitCode } from '../lib/features/cli/exit-code.ts';
import { createFakeGitHub, pullRequestBody } from '../lib/features/github/testing/fake-github.ts';
import { orgDisplay, successfulDeployment } from '../lib/features/salesforce/testing/fake-sf.ts';
import {
	DEPLOYMENT_ID,
	githubContext,
	pipelineFixtures,
	VALIDATION_ID,
} from './testing/pipeline-fixture.ts';
import type { PipelineFixture } from './testing/pipeline-fixture.ts';

const { setUp } = pipelineFixtures();

const TOKEN = { GITHUB_TOKEN: 'a-scoped-token' };

/** A validated run is the starting point of every deployment below. */
async function validatedRun(): Promise<PipelineFixture> {
	const setup = await setUp();
	const outcome = await runCli(
		['validate', ...setup.validation, '--out', setup.validated, '--json'],
		setup.context,
	);
	expect(outcome.exitCode).toBe(ExitCode.success);
	return setup;
}

describe('a deployment that follows a merge', () => {
	function pullRequest(setup: PipelineFixture, overrides: Record<string, unknown>) {
		return createFakeGitHub({
			'GET /repos/acme/salesforce/pulls/42': {
				status: 200,
				body: pullRequestBody({
					base: {
						ref: 'main',
						sha: setup.repository.baseSha,
						repo: { full_name: 'acme/salesforce' },
					},
					head: {
						ref: 'feature',
						sha: setup.repository.headSha,
						repo: { full_name: 'acme/salesforce' },
					},
					...overrides,
				}),
			},
		});
	}

	function deployArgv(setup: PipelineFixture) {
		return [
			'deploy',
			...setup.deployment,
			'--repository',
			'acme/salesforce',
			'--pull-request',
			'42',
			'--validated-run',
			setup.validated,
			'--require-merged',
			'--out',
			join(setup.context.cwd, 'deploy'),
			'--json',
		];
	}

	test('a merged pull request deploys and records its merge commit', async () => {
		const setup = await validatedRun();
		const github = pullRequest(setup, {
			state: 'closed',
			merged: true,
			merge_commit_sha: 'c'.repeat(40),
		});

		const outcome = await runCli(deployArgv(setup), {
			...setup.context,
			env: TOKEN,
			...githubContext(github),
		});

		expect(outcome.exitCode).toBe(ExitCode.success);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.mergeCommit).toBe('c'.repeat(40));
		expect(data.run.deployment.deploymentId).toBe(DEPLOYMENT_ID);
	});

	test('closing without merging deploys nothing', async () => {
		const setup = await validatedRun();
		const github = pullRequest(setup, { state: 'closed', merged: false });

		const outcome = await runCli(deployArgv(setup), {
			...setup.context,
			env: TOKEN,
			...githubContext(github),
		});

		expect(JSON.parse(outcome.stdout).error.code).toBe('pull_request_not_eligible');
		expect(await setup.calls()).not.toContain('project deploy start');
	});

	test('a head that moved after the check went green deploys nothing', async () => {
		const setup = await validatedRun();
		const github = pullRequest(setup, {
			state: 'closed',
			merged: true,
			merge_commit_sha: 'c'.repeat(40),
			head: { ref: 'feature', sha: 'd'.repeat(40), repo: { full_name: 'acme/salesforce' } },
		});

		const outcome = await runCli(deployArgv(setup), {
			...setup.context,
			env: TOKEN,
			...githubContext(github),
		});

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await setup.calls()).not.toContain('project deploy start');
	});
});

describe('a local deployment of a validated plan', () => {
	test('deploys the exact plan as a new Salesforce operation', async () => {
		const { context, deployment, validated: directory } = await validatedRun();

		const outcome = await runCli(
			[
				'deploy',
				...deployment,
				'--validated-run',
				directory,
				'--out',
				join(context.cwd, 'deploy'),
				'--json',
			],
			context,
		);

		expect(outcome.exitCode).toBe(ExitCode.success);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.kind).toBe('deploy');
		expect(data.run.deployment.deploymentId).toBe(DEPLOYMENT_ID);
		expect(data.run.deployment.deploymentId).not.toBe(VALIDATION_ID);
		expect(data.run.deployment.checkOnly).toBe(false);
		// The same tests the validation ran, from the same plan.
		expect(data.run.plan.tests).toEqual({ mode: 'all' });
		expect(data.run.validation.planIdentity).toBe(data.run.plan.identity);
	});

	test('an edited plan is refused and no deployment is started', async () => {
		const { context, deployment, validated: directory, calls } = await validatedRun();

		const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
		plan.source.headSha = 'c'.repeat(40);
		await writeFile(join(directory, 'plan.json'), JSON.stringify(plan), 'utf8');

		const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
		run.plan.source.headSha = 'c'.repeat(40);
		await writeFile(join(directory, 'run.json'), JSON.stringify(run), 'utf8');

		const outcome = await runCli(
			['deploy', ...deployment, '--validated-run', directory, '--out', join(context.cwd, 'deploy'), '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('an edited manifest is refused and no deployment is started', async () => {
		const { context, deployment, validated: directory, calls } = await validatedRun();

		await writeFile(join(directory, 'package.xml'), '<?xml version="1.0"?>\n<Package/>\n', 'utf8');

		const outcome = await runCli(
			['deploy', ...deployment, '--validated-run', directory, '--out', join(context.cwd, 'deploy'), '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('artifacts not named by the green check plan identity are refused', async () => {
		const { context, deployment, validated: directory, calls } = await validatedRun();
		const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
		const expected = `${plan.identity.slice(0, -1)}${plan.identity.endsWith('0') ? '1' : '0'}`;

		const outcome = await runCli(
			[
				'deploy',
				...deployment,
				'--validated-run', directory,
				'--expected-plan-identity', expected,
				'--out', join(context.cwd, 'deploy'),
				'--json',
			],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('a failed validation cannot be deployed', async () => {
		const { context, deployment, validated: directory, calls } = await validatedRun();

		const validation = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
		validation.verdict = 'failed';
		validation.failures = ['someone said so'];
		await writeFile(join(directory, 'validation.json'), JSON.stringify(validation), 'utf8');
		const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
		run.status = 'failed';
		run.validation = validation;
		await writeFile(join(directory, 'run.json'), JSON.stringify(run), 'utf8');

		const outcome = await runCli(
			['deploy', ...deployment, '--validated-run', directory, '--out', join(context.cwd, 'deploy'), '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('validation_not_passed');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('an org that is no longer the validated one is refused', async () => {
		const setup = await validatedRun();

		// The alias now points somewhere else.
		await setup.useSalesforce({
			responses: [
				{ when: ['org', 'display'], stdout: orgDisplay('00D000000000999EAA') },
				{ when: ['deploy', 'start'], stdout: successfulDeployment({ id: DEPLOYMENT_ID }) },
			],
		});

		const outcome = await runCli(
			[
				'deploy',
				...setup.deployment,
				'--validated-run',
				setup.validated,
				'--out',
				join(setup.context.cwd, 'deploy'),
				'--json',
			],
			setup.context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('org_mismatch');
		expect(await setup.calls()).not.toContain('project deploy start');
	});
});
