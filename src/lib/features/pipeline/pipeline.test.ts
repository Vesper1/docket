import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { runCli } from '../cli/cli.ts';
import { ExitCode } from '../cli/exit-code.ts';
import { createGitFixture } from '../git/testing/git-fixture.ts';
import type { GitFixture } from '../git/testing/git-fixture.ts';
import { createFakeGitHub, pullRequestBody } from '../github/testing/fake-github.ts';
import type { FakeGitHub } from '../github/testing/fake-github.ts';
import {
	createFakeSf,
	failedDeployment,
	orgDisplay,
	successfulDeployment,
} from '../salesforce/testing/fake-sf.ts';
import type { FakeSf, FakeSfBehaviour } from '../salesforce/testing/fake-sf.ts';

const CLASSES = 'force-app/main/default/classes';

const CONFIG = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests:
      mode: all
`;

const PROJECT = JSON.stringify({
	packageDirectories: [{ path: 'force-app', default: true }],
	sourceApiVersion: '62.0',
});

/** The CLI answers `org display` and the two deploy verbs differently. */
const VALIDATION_ID = '0Af000000000001CAA';
const DEPLOYMENT_ID = '0Af000000000009CAA';

const RESPONSES: FakeSfBehaviour = {
	responses: [
		{ when: ['org', 'display'], stdout: orgDisplay() },
		{ when: ['deploy', 'validate'], stdout: successfulDeployment() },
		{
			when: ['deploy', 'start'],
			stdout: successfulDeployment({ id: DEPLOYMENT_ID, checkOnly: false }),
		},
	],
};

let fixture: GitFixture | undefined;
let fake: FakeSf | undefined;
let workDirectory: string | undefined;

afterEach(async () => {
	await fixture?.remove();
	await fake?.remove();
	if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true });
	fixture = undefined;
	fake = undefined;
	workDirectory = undefined;
});

async function repository(config = CONFIG, deletion = false): Promise<GitFixture> {
	const base = {
		'docket.yml': config,
		'sfdx-project.json': PROJECT,
		[`${CLASSES}/Foo.cls`]: 'public class Foo {}',
	};

	const head = deletion
		? { 'docket.yml': config, 'sfdx-project.json': PROJECT }
		: { ...base, [`${CLASSES}/Bar.cls`]: 'public class Bar {}' };

	return createGitFixture({ base, head });
}

async function setUp(behaviour: FakeSfBehaviour = RESPONSES, config = CONFIG, deletion = false) {
	fixture = await repository(config, deletion);
	fake = await createFakeSf(behaviour);
	workDirectory = await mkdtemp(join(tmpdir(), 'docket-pipeline-'));

	const context = {
		version: '9.9.9',
		cwd: workDirectory,
		env: {},
		now: () => new Date('2026-08-16T10:00:00.000Z'),
	};

	const common = [
		'--repo',
		fixture.directory,
		'--repository',
		'acme/salesforce',
		'--pull-request',
		'42',
		'--base',
		fixture.baseSha,
		'--head',
		fixture.headSha,
		'--environment',
		'qa',
		'--sf',
		fake.executable,
		'--wait',
		'1',
	];

	return { context, common, validated: join(workDirectory, 'validate') };
}

/** Points a run at the fake GitHub instead of the real API. */
function githubContext(github: FakeGitHub) {
	return { fetch: github.fetch, githubBaseUrl: github.baseUrl };
}

/** The subcommand words of every call the fake received. */
async function calls(): Promise<string[]> {
	const invocations = (await fake?.invocations()) ?? [];
	return invocations.map((argv) => argv.slice(0, 3).join(' '));
}

describe('a local validation', () => {
	test('validates the exact plan and records the run', async () => {
		const { context, common, validated } = await setUp();

		const outcome = await runCli(['validate', ...common, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.kind).toBe('validate');
		expect(data.run.status).toBe('passed');
		expect(data.run.plan.components.deployable).toEqual([
			{ type: 'ApexClass', member: 'Bar', change: 'added' },
		]);
		expect(data.run.validation.deployment.deploymentId).toBe(VALIDATION_ID);
		expect(await calls()).toEqual(['org display --target-org', 'project deploy validate']);
	});

	test('records GitHub Actions provenance only as a complete tuple', async () => {
		const { context, common, validated } = await setUp();

		const outcome = await runCli(
			[
				'validate',
				...common,
				'--out',
				validated,
				'--workflow-run-id',
				'123456',
				'--workflow-run-attempt',
				'2',
				'--json',
			],
			context,
		);

		const run = JSON.parse(outcome.stdout).data.run;
		expect(run.executor).toBe('github-actions');
		expect(run.workflow).toEqual({ runId: '123456', runAttempt: 2 });
		expect(run.artifactsExpireAt).toBeNull();
	});

	test('the run states when its own artifacts expire', async () => {
		const { context, common, validated } = await setUp();

		const outcome = await runCli(
			[
				'validate',
				...common,
				'--out',
				validated,
				'--artifacts-expire-at',
				'2026-11-14T00:00:00.000Z',
				'--json',
			],
			context,
		);

		expect(JSON.parse(outcome.stdout).data.run.artifactsExpireAt).toBe('2026-11-14T00:00:00.000Z');

		const loose = await runCli(
			['validate', ...common, '--out', validated, '--artifacts-expire-at', '14 Nov 2026', '--json'],
			context,
		);

		expect(loose.exitCode).toBe(ExitCode.usage);
		expect(JSON.parse(loose.stdout).error.code).toBe('invalid_option');
	});

	test('the artifacts of §6 are on disk, and the plan is the one recorded', async () => {
		const { context, common, validated } = await setUp();

		await runCli(['validate', ...common, '--out', validated], context);

		const plan = JSON.parse(await readFile(join(validated, 'plan.json'), 'utf8'));
		const validation = JSON.parse(await readFile(join(validated, 'validation.json'), 'utf8'));
		const manifest = await readFile(join(validated, 'package.xml'), 'utf8');

		expect(validation.planIdentity).toBe(plan.identity);
		expect(validation.verdict).toBe('passed');
		expect(manifest).toContain('<members>Bar</members>');
		expect(await readFile(join(validated, 'report.md'), 'utf8')).toContain('| ApexClass | Bar | added |');
	});

	test('trusted configuration comes from the base commit, not from the change', async () => {
		fixture = await createGitFixture({
			base: {
				'docket.yml': CONFIG,
				'sfdx-project.json': PROJECT,
				[`${CLASSES}/Foo.cls`]: 'public class Foo {}',
			},
			head: {
				// The pull request repoints the environment at another org.
				'docket.yml': CONFIG.replace('docket-qa', 'production'),
				'sfdx-project.json': PROJECT,
				[`${CLASSES}/Foo.cls`]: 'public class Foo {}',
				[`${CLASSES}/Bar.cls`]: 'public class Bar {}',
			},
		});
		fake = await createFakeSf(RESPONSES);
		workDirectory = await mkdtemp(join(tmpdir(), 'docket-pipeline-'));

		const outcome = await runCli(
			[
				'plan',
				'--repo',
				fixture.directory,
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--base',
				fixture.baseSha,
				'--head',
				fixture.headSha,
				'--environment',
				'qa',
				'--sf',
				fake.executable,
				'--json',
			],
			{
				version: '9.9.9',
				cwd: workDirectory,
				env: {},
				now: () => new Date('2026-08-16T10:00:00.000Z'),
			},
		);

		expect(JSON.parse(outcome.stdout).data.plan.target.org).toBe('docket-qa');
	});

	test('a failed Salesforce validation exits non-zero and still records why', async () => {
		const { context, common, validated } = await setUp({
			responses: [
				{ when: ['org', 'display'], stdout: orgDisplay() },
				{ when: ['deploy', 'validate'], stdout: failedDeployment(), exitCode: 1 },
			],
		});

		const outcome = await runCli(['validate', ...common, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.failure);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.status).toBe('failed');
		expect(data.run.validation.failures).toContain('ApexClass Foo: Variable does not exist: bar');

		const validation = JSON.parse(await readFile(join(validated, 'validation.json'), 'utf8'));
		expect(validation.verdict).toBe('failed');
	});

	test('a forbidden deletion stops before Salesforce is asked anything', async () => {
		const { context, common, validated } = await setUp(RESPONSES, CONFIG, true);

		const outcome = await runCli(['validate', ...common, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.failure);
		expect(JSON.parse(outcome.stdout).error.code).toBe('destructive_not_allowed');
		expect(await calls()).toEqual(['org display --target-org']);
	});

	test('a wrong target branch is refused', async () => {
		const { context, common, validated } = await setUp();

		const outcome = await runCli(
			['validate', ...common, '--out', validated, '--target-branch', 'release/x', '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('branch_mismatch');
	});
});

describe('a destructive change', () => {
	const PERMISSIVE = CONFIG.replace('allowDestructiveChanges: false', 'allowDestructiveChanges: true');

	test('is planned, manifested and passed to Salesforce once the policy allows it', async () => {
		const { context, common, validated } = await setUp(RESPONSES, PERMISSIVE, true);

		const outcome = await runCli(['validate', ...common, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.plan.components.destructive).toEqual([
			{ type: 'ApexClass', member: 'Foo', change: 'deleted' },
		]);

		const destructive = await readFile(join(validated, 'destructiveChanges.xml'), 'utf8');
		expect(destructive).toContain('<members>Foo</members>');

		const invocations = (await fake?.invocations()) ?? [];
		const validateCall = invocations.find((argv) => argv.includes('validate')) ?? [];
		expect(validateCall).toContain('--pre-destructive-changes');
	});

	test('the report says plainly what will be deleted', async () => {
		const { context, common, validated } = await setUp(RESPONSES, PERMISSIVE, true);

		await runCli(['validate', ...common, '--out', validated], context);

		const report = await readFile(join(validated, 'report.md'), 'utf8');
		expect(report).toContain('## Delete (1)');
		expect(report).toContain('| ApexClass | Foo | deleted |');
		expect(report).toContain('| Destructive changes | allowed |');
	});

	test('turning the policy on changes the plan identity, so old validation cannot stand', async () => {
		const strict = await setUp(RESPONSES, CONFIG, false);
		const first = await runCli(['plan', ...strict.common, '--json'], strict.context);

		const permissive = await setUp(RESPONSES, PERMISSIVE, false);
		const second = await runCli(['plan', ...permissive.common, '--json'], permissive.context);

		expect(JSON.parse(first.stdout).data.plan.identity).not.toBe(
			JSON.parse(second.stdout).data.plan.identity,
		);
	});
});

describe('the merge gate', () => {
	async function validatedRun(behaviour: FakeSfBehaviour = RESPONSES) {
		const setup = await setUp(behaviour);
		await runCli(
			[
				'validate',
				...setup.common,
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
		const { context, validated } = await validatedRun();
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
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
		);

		expect(outcome.exitCode).toBe(ExitCode.success);
		const posted = github.requests()[0]?.body as Record<string, unknown>;
		expect(posted['name']).toBe('docket/validate');
		expect(posted['conclusion']).toBe('success');
		expect(posted['head_sha']).toBe(fixture?.headSha);
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
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
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
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
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
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(github.requests()).toEqual([]);
	});

	test('the deployment finds the exact run behind the green check', async () => {
		const { context } = await setUp();
		const github = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${fixture?.headSha}/check-runs`]: {
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
			['locate-run', '--repository', 'acme/salesforce', '--head', fixture?.headSha ?? ''],
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
		);

		expect(outcome.stdout).toBe('99\n');
	});

	test('a red or missing check locates nothing', async () => {
		const { context } = await setUp();
		const red = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${fixture?.headSha}/check-runs`]: {
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
			['locate-run', '--repository', 'acme/salesforce', '--head', fixture?.headSha ?? '', '--json'],
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(red) },
		);

		expect(JSON.parse(failed.stdout).error.code).toBe('validation_not_passed');

		const absent = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${fixture?.headSha}/check-runs`]: {
				status: 200,
				body: { check_runs: [] },
			},
		});

		const missing = await runCli(
			['locate-run', '--repository', 'acme/salesforce', '--head', fixture?.headSha ?? '', '--json'],
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(absent) },
		);

		expect(JSON.parse(missing.stdout).error.code).toBe('validation_not_passed');
	});
});

describe('a deployment that follows a merge', () => {
	async function validatedRun() {
		const setup = await setUp();
		await runCli(['validate', ...setup.common, '--out', setup.validated, '--json'], setup.context);
		return setup;
	}

	function pullRequest(overrides: Record<string, unknown>) {
		return createFakeGitHub({
			'GET /repos/acme/salesforce/pulls/42': {
				status: 200,
				body: pullRequestBody({
					base: { ref: 'main', sha: fixture?.baseSha, repo: { full_name: 'acme/salesforce' } },
					head: { ref: 'feature', sha: fixture?.headSha, repo: { full_name: 'acme/salesforce' } },
					...overrides,
				}),
			},
		});
	}

	function deployArgv(context: { cwd: string }, validated: string) {
		return [
			'deploy',
			'--repo',
			fixture?.directory ?? '',
			'--repository',
			'acme/salesforce',
			'--pull-request',
			'42',
			'--sf',
			fake?.executable ?? '',
			'--wait',
			'1',
			'--validated-run',
			validated,
			'--require-merged',
			'--out',
			join(context.cwd, 'deploy'),
			'--json',
		];
	}

	test('a merged pull request deploys and records its merge commit', async () => {
		const { context, validated } = await validatedRun();
		const github = pullRequest({
			state: 'closed',
			merged: true,
			merge_commit_sha: 'c'.repeat(40),
		});

		const outcome = await runCli(deployArgv(context, validated), {
			...context,
			env: { GITHUB_TOKEN: 'a-scoped-token' },
			...githubContext(github),
		});

		expect(outcome.exitCode).toBe(ExitCode.success);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.mergeCommit).toBe('c'.repeat(40));
		expect(data.run.deployment.deploymentId).toBe(DEPLOYMENT_ID);
	});

	test('closing without merging deploys nothing', async () => {
		const { context, validated } = await validatedRun();
		const github = pullRequest({ state: 'closed', merged: false });

		const outcome = await runCli(deployArgv(context, validated), {
			...context,
			env: { GITHUB_TOKEN: 'a-scoped-token' },
			...githubContext(github),
		});

		expect(JSON.parse(outcome.stdout).error.code).toBe('pull_request_not_eligible');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('a head that moved after the check went green deploys nothing', async () => {
		const { context, validated } = await validatedRun();
		const github = pullRequest({
			state: 'closed',
			merged: true,
			merge_commit_sha: 'c'.repeat(40),
			head: { ref: 'feature', sha: 'd'.repeat(40), repo: { full_name: 'acme/salesforce' } },
		});

		const outcome = await runCli(deployArgv(context, validated), {
			...context,
			env: { GITHUB_TOKEN: 'a-scoped-token' },
			...githubContext(github),
		});

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});
});

describe('a plan built from a pull request', () => {
	test('a non-SHA ref is refused before Git is run', async () => {
		const { context } = await setUp();

		const outcome = await runCli(
			[
				'changes',
				'--repo', fixture?.directory ?? '',
				'--base', 'not-a-commit-sha',
				'--head', fixture?.headSha ?? '',
				'--json',
			],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('invalid_option');
	});

	test('GitHub supplies the exact SHAs and the branch the plan is checked against', async () => {
		const { context, common } = await setUp();
		const repository = fixture?.directory ?? '';
		const github = createFakeGitHub({
			'GET /repos/acme/salesforce/pulls/42': {
				status: 200,
				body: pullRequestBody({
					base: {
						ref: 'main',
						sha: fixture?.baseSha,
						repo: { full_name: 'acme/salesforce' },
					},
					head: {
						ref: 'feature',
						sha: fixture?.headSha,
						repo: { full_name: 'acme/salesforce' },
					},
				}),
			},
		});

		const fromGitHub = await runCli(
			[
				'plan',
				'--repo',
				repository,
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--environment',
				'qa',
				'--sf',
				fake?.executable ?? '',
				'--json',
			],
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
		);

		const local = await runCli(['plan', ...common, '--json'], context);

		expect(fromGitHub.exitCode).toBe(ExitCode.success);
		expect(JSON.parse(fromGitHub.stdout).data.plan).toEqual(JSON.parse(local.stdout).data.plan);
	});

	test('a draft pull request is refused before any plan exists', async () => {
		const { context } = await setUp();
		const github = createFakeGitHub({
			'GET /repos/acme/salesforce/pulls/42': {
				status: 200,
				body: pullRequestBody({ draft: true }),
			},
		});

		const outcome = await runCli(
			[
				'plan',
				'--repo',
				fixture?.directory ?? '',
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--environment',
				'qa',
				'--json',
			],
			{ ...context, env: { GITHUB_TOKEN: 'a-scoped-token' }, ...githubContext(github) },
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('pull_request_not_eligible');
	});

	test('without a token and without explicit SHAs, nothing is guessed', async () => {
		const { context } = await setUp();

		const outcome = await runCli(
			[
				'plan',
				'--repo',
				fixture?.directory ?? '',
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--environment',
				'qa',
				'--json',
			],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('missing_option');
	});
});

describe('a local deployment of a validated plan', () => {
	async function validated() {
		const setup = await setUp();
		const outcome = await runCli(
			['validate', ...setup.common, '--out', setup.validated, '--json'],
			setup.context,
		);
		expect(outcome.exitCode).toBe(ExitCode.success);
		return setup;
	}

	test('deploys the exact plan as a new Salesforce operation', async () => {
		const { context, common, validated: directory } = await validated();

		const outcome = await runCli(
			[
				'deploy',
				...common,
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
		const { context, common, validated: directory } = await validated();

		const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
		plan.source.headSha = 'c'.repeat(40);
		await writeFile(join(directory, 'plan.json'), JSON.stringify(plan), 'utf8');

		const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
		run.plan.source.headSha = 'c'.repeat(40);
		await writeFile(join(directory, 'run.json'), JSON.stringify(run), 'utf8');

		const outcome = await runCli(
			['deploy', ...common, '--validated-run', directory, '--out', join(context.cwd, 'deploy'), '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('an edited manifest is refused and no deployment is started', async () => {
		const { context, common, validated: directory } = await validated();

		await writeFile(join(directory, 'package.xml'), '<?xml version="1.0"?>\n<Package/>\n', 'utf8');

		const outcome = await runCli(
			['deploy', ...common, '--validated-run', directory, '--out', join(context.cwd, 'deploy'), '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('plan_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('artifacts not named by the green check plan identity are refused', async () => {
		const { context, common, validated: directory } = await validated();
		const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
		const expected = `${plan.identity.slice(0, -1)}${plan.identity.endsWith('0') ? '1' : '0'}`;

		const outcome = await runCli(
			[
				'deploy',
				...common,
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
		const { context, common, validated: directory } = await validated();

		const validation = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
			validation.verdict = 'failed';
			validation.failures = ['someone said so'];
			await writeFile(join(directory, 'validation.json'), JSON.stringify(validation), 'utf8');
			const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
			run.status = 'failed';
			run.validation = validation;
			await writeFile(join(directory, 'run.json'), JSON.stringify(run), 'utf8');

		const outcome = await runCli(
			['deploy', ...common, '--validated-run', directory, '--out', join(context.cwd, 'deploy'), '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('validation_not_passed');
		expect(await calls()).not.toContain('project deploy start');
	});

	test('an org that is no longer the validated one is refused', async () => {
		const setup = await setUp();
		await runCli(['validate', ...setup.common, '--out', setup.validated, '--json'], setup.context);

		// The alias now points somewhere else.
		await fake?.remove();
		fake = await createFakeSf({
			responses: [
				{ when: ['org', 'display'], stdout: orgDisplay('00D000000000999EAA') },
				{ when: ['deploy', 'start'], stdout: successfulDeployment({ id: DEPLOYMENT_ID }) },
			],
		});

		const outcome = await runCli(
			[
				'deploy',
				'--repo',
				fixture?.directory ?? '',
				'--sf',
				fake.executable,
				'--wait',
				'1',
				'--validated-run',
				setup.validated,
				'--out',
				join(setup.context.cwd, 'deploy'),
				'--json',
			],
			setup.context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('org_mismatch');
		expect(await calls()).not.toContain('project deploy start');
	});
});

describe('M10 gates and deployment steps end to end', () => {
	function config(pre = 'bash scripts/pre.sh', post = 'bash scripts/post.sh', gate = 'exit 0') {
		return `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: lint
        run: ${gate}
    preDeployment:
      - name: prepare
        run: ${pre}
      - name: release-window
        manual: true
        instructions: Confirm the release window
    postDeployment:
      - name: smoke
        run: ${post}
`;
	}

	async function m10Setup(configuration: string, headScripts = { pre: 'exit 91', post: 'exit 92' }) {
		const base = {
			'docket.yml': configuration,
			'sfdx-project.json': PROJECT,
			[`${CLASSES}/Foo.cls`]: 'public class Foo {}',
			'scripts/pre.sh': 'exit 0',
			'scripts/post.sh': 'exit 0',
		};
		fixture = await createGitFixture({
			base,
			head: {
				...base,
				[`${CLASSES}/Bar.cls`]: 'public class Bar {}',
				'scripts/pre.sh': headScripts.pre,
				'scripts/post.sh': headScripts.post,
			},
		});
		fake = await createFakeSf(RESPONSES);
		workDirectory = await mkdtemp(join(tmpdir(), 'docket-m10-'));
		const context = {
			version: '9.9.9',
			cwd: workDirectory,
			env: {},
			now: () => new Date('2026-08-16T10:00:00.000Z'),
		};
		const common = [
			'--repo', fixture.directory,
			'--repository', 'acme/salesforce',
			'--pull-request', '42',
			'--base', fixture.baseSha,
			'--head', fixture.headSha,
			'--target-branch', 'main',
			'--environment', 'qa',
			'--sf', fake.executable,
			'--wait', '1',
		];
		return {
			context,
			common,
			gates: join(workDirectory, 'gates'),
			validated: join(workDirectory, 'validated'),
			steps: join(workDirectory, 'steps'),
			deployed: join(workDirectory, 'deployed'),
		};
	}

	test('a failed credential-free gate cannot start Salesforce validation', async () => {
		const setup = await m10Setup(config('exit 0', 'exit 0', 'exit 12'));
		const gate = await runCli(['gates', ...setup.common, '--out', setup.gates, '--json'], setup.context);
		expect(gate.exitCode).toBe(ExitCode.failure);

		const validation = await runCli(
			['validate', ...setup.common, '--gates-run', setup.gates, '--out', setup.validated, '--json'],
			setup.context,
		);
		expect(JSON.parse(validation.stdout).error.code).toBe('validation_not_passed');
		expect(await calls()).not.toContain('project deploy validate');
	});

	test('manual completion unlocks trusted base hooks and records the post hook', async () => {
		const setup = await m10Setup(config());
		expect(
			(await runCli(['gates', ...setup.common, '--out', setup.gates, '--json'], setup.context)).exitCode,
		).toBe(ExitCode.success);

		const validation = await runCli(
			['validate', ...setup.common, '--gates-run', setup.gates, '--out', setup.validated, '--json'],
			setup.context,
		);
		const validationRun = JSON.parse(validation.stdout).data.run;
		expect(validationRun.steps.map((step: { name: string }) => step.name)).toEqual([
			'lint',
			'release-window',
		]);
		expect(validationRun.steps[1].status).toBe('pending');

		const blocked = await runCli(
			[
				'deploy', ...setup.common,
				'--validated-run', setup.validated,
				'--out', setup.deployed,
				'--json',
			],
			setup.context,
		);
		expect(JSON.parse(blocked.stdout).error.code).toBe('step_incomplete');

		const completed = await runCli(
			[
				'complete-step',
				'--validated-run', setup.validated,
				'--step', 'release-window',
				'--by', 'taras',
				'--steps', setup.steps,
				'--json',
			],
			setup.context,
		);
		expect(completed.exitCode).toBe(ExitCode.success);

		const deployment = await runCli(
			[
				'deploy', ...setup.common,
				'--validated-run', setup.validated,
				'--steps', setup.steps,
				'--out', setup.deployed,
				'--json',
			],
			setup.context,
		);
		expect(deployment.exitCode).toBe(ExitCode.success);
		const run = JSON.parse(await readFile(join(setup.deployed, 'run.json'), 'utf8'));
		expect(run.steps).toEqual([
			{ name: 'prepare', kind: 'pre', manual: false, status: 'passed', exitCode: 0, completedBy: null },
			{ name: 'release-window', kind: 'pre', manual: true, status: 'passed', exitCode: null, completedBy: 'taras' },
			{ name: 'smoke', kind: 'post', manual: false, status: 'passed', exitCode: 0, completedBy: null },
		]);
		// Head changed both scripts to fail. Passing proves privileged bytes came
		// from the trusted base workspace instead.
		expect(run.status).toBe('passed');
	});

	test('missing publication provenance creates no completion record', async () => {
		const setup = await m10Setup(config());
		await runCli(['gates', ...setup.common, '--out', setup.gates], setup.context);
		await runCli(
			['validate', ...setup.common, '--gates-run', setup.gates, '--out', setup.validated],
			setup.context,
		);

		const outcome = await runCli(
			[
				'complete-step',
				'--repository', 'acme/salesforce',
				'--validated-run', setup.validated,
				'--step', 'release-window',
				'--by', 'taras',
				'--steps', setup.steps,
				'--json',
			],
			setup.context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('missing_option');
		expect(await readdir(setup.steps).catch(() => [])).toEqual([]);
	});

	test('the publish phase reuses the immutable completion recorded before upload', async () => {
		const setup = await m10Setup(config());
		await runCli(['gates', ...setup.common, '--out', setup.gates], setup.context);
		await runCli(
			['validate', ...setup.common, '--gates-run', setup.gates, '--out', setup.validated],
			setup.context,
		);
		const plan = JSON.parse(await readFile(join(setup.validated, 'plan.json'), 'utf8'));
		const externalId = JSON.stringify({
			v: 1,
			s: 'release-window',
			p: plan.identity,
			vr: '123456',
			cr: null,
		});
		const github = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${plan.source.headSha}/check-runs`]: {
				status: 200,
				body: { check_runs: [{ id: 12, external_id: externalId }] },
			},
			'PATCH /repos/acme/salesforce/check-runs/12': { status: 200, body: { id: 12 } },
		});
		const common = [
			'complete-step',
			'--validated-run', setup.validated,
			'--step', 'release-window',
			'--by', 'taras',
			'--workflow-run-id', '777',
			'--steps', setup.steps,
		];

		const recorded = await runCli(common, setup.context);
		const published = await runCli(
			[...common, '--repository', 'acme/salesforce', '--json'],
			{
				...setup.context,
				env: { GITHUB_TOKEN: 'a-scoped-token' },
				...githubContext(github),
			},
		);

		expect(recorded.exitCode).toBe(ExitCode.success);
		expect(published.exitCode).toBe(ExitCode.success);
		expect(await readdir(setup.steps)).toHaveLength(1);
		expect(github.requests().at(-1)?.method).toBe('PATCH');
	});

	test('a failing trusted pre-hook records its exit and stops before deploy', async () => {
		const setup = await m10Setup(config('exit 23', 'exit 0'), { pre: 'exit 0', post: 'exit 0' });
		await runCli(['gates', ...setup.common, '--out', setup.gates], setup.context);
		await runCli(
			['validate', ...setup.common, '--gates-run', setup.gates, '--out', setup.validated],
			setup.context,
		);
		await runCli(
			[
				'complete-step',
				'--validated-run', setup.validated,
				'--step', 'release-window',
				'--by', 'taras',
				'--steps', setup.steps,
			],
			setup.context,
		);

		const deployment = await runCli(
			[
				'deploy', ...setup.common,
				'--validated-run', setup.validated,
				'--steps', setup.steps,
				'--out', setup.deployed,
				'--json',
			],
			setup.context,
		);
		expect(deployment.exitCode).toBe(ExitCode.failure);
		const run = JSON.parse(deployment.stdout).data.run;
		expect(run.steps[0]).toMatchObject({ name: 'prepare', status: 'failed', exitCode: 23 });
		expect(run.deployment).toBeNull();
		expect(await calls()).not.toContain('project deploy start');
	});
});
