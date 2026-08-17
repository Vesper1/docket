import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { isErr, isOk } from '../lib/shared/result/result.ts';
import { runCli } from '../lib/features/cli/cli.ts';
import type { EnvironmentConfig } from '../lib/features/config/docket-config.ts';
import { runGit } from '../lib/features/git/git-command.ts';
import { readChanges } from '../lib/features/git/read-changes.ts';
import { createGitFixture } from '../lib/features/git/testing/git-fixture.ts';
import type { GitFixture, TreeSnapshot } from '../lib/features/git/testing/git-fixture.ts';
import { createCompensatingPullRequest } from '../lib/features/github/rollback-pull-request.ts';
import { createFakeGitHub } from '../lib/features/github/testing/fake-github.ts';
import { buildPlan } from '../lib/features/plan/build-plan.ts';
import type { PlanArtifacts } from '../lib/features/plan/deployment-plan.ts';
import { RUN_SCHEMA } from '../lib/features/run/run-record.ts';
import type { RunRecord } from '../lib/features/run/run-record.ts';
import { writeRunArtifacts } from '../lib/features/run/write-artifacts.ts';
import type { DeploymentOutcome } from '../lib/features/salesforce/deploy.ts';
import { validationRecordOf } from '../lib/features/validation/validation-record.ts';
import { buildRollbackProposal } from '../lib/features/rollback/build-rollback.ts';

const CLASSES = 'force-app/main/default/classes';
const CONFIG = `version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: true
    tests: { mode: all }
`;

const ENVIRONMENT: EnvironmentConfig = {
	id: 'qa',
	branch: 'main',
	org: 'docket-qa',
	allowDestructiveChanges: true,
	tests: { mode: 'all' },
	gates: [],
	preDeployment: [],
	postDeployment: [],
};

const VALIDATION: DeploymentOutcome = {
	deploymentId: '0AfValidation',
	status: 'Succeeded',
	success: true,
	checkOnly: true,
	componentFailures: [],
	tests: { run: 1, failed: 0, failures: [] },
};

let fixture: GitFixture | undefined;
let workDirectory: string | undefined;
let sourcePlan: PlanArtifacts | undefined;

afterEach(async () => {
	await fixture?.remove();
	if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true });
	fixture = undefined;
	workDirectory = undefined;
	sourcePlan = undefined;
});

async function deployedRun(base: TreeSnapshot, head: TreeSnapshot): Promise<RunRecord> {
	fixture = await createGitFixture({
		base: { 'docket.yml': CONFIG, ...base },
		head: { 'docket.yml': CONFIG, ...head },
	});
	const changes = await readChanges({
		cwd: fixture.directory,
		baseSha: fixture.baseSha,
		headSha: fixture.headSha,
	});
	if (!isOk(changes)) throw new Error('expected changes');

	const plan = buildPlan({
		source: {
			repository: 'acme/salesforce',
			pullRequest: 42,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
		},
		environment: ENVIRONMENT,
		orgId: '00D000000000001EAA',
		apiVersion: '62.0',
		sourceRoot: 'force-app',
		changes: changes.value,
	});
	if (!isOk(plan)) throw new Error('expected plan');
	sourcePlan = plan.value;
	const validation = validationRecordOf({ plan: plan.value.plan, steps: [], deployment: VALIDATION });

	return {
		schema: RUN_SCHEMA,
		kind: 'deploy',
		executor: 'local',
		status: 'passed',
		timing: {
			startedAt: '2026-08-16T10:00:00.000Z',
			finishedAt: '2026-08-16T10:01:00.000Z',
		},
		plan: plan.value.plan,
		validation,
		deployment: { ...VALIDATION, deploymentId: '0AfDeployment', checkOnly: false },
		steps: [],
		workflow: null,
		mergeCommit: null,
		artifactsExpireAt: null,
	};
}

describe('M11.2–M11.4 inverse ApexClass changes', () => {
	test('an added class becomes one exact destructive member', async () => {
		const run = await deployedRun(
			{},
			{
				[`${CLASSES}/Foo.cls`]: 'public class Foo {}\n',
				[`${CLASSES}/Foo.cls-meta.xml`]: '<ApexClass/>\n',
			},
		);
		const proposal = await buildRollbackProposal({
			repositoryDirectory: fixture?.directory ?? '',
			sourceRun: run,
			currentBaseSha: fixture?.headSha ?? '',
		});

		expect(isOk(proposal)).toBe(true);
		if (!proposal.ok) return;
		expect(proposal.value.plan.packageXml).not.toContain('<members>');
		expect(proposal.value.plan.destructiveChangesXml).toContain('<members>Foo</members>');
		expect(proposal.value.plan.components.destructive).toEqual([
			{ type: 'ApexClass', member: 'Foo', change: 'deleted' },
		]);
		expect(proposal.value.plan.operations.map((operation) => operation.kind)).toEqual([
			'delete',
			'delete',
		]);
	});

	test('a modified class restores byte-for-byte content from the source base', async () => {
		const oldContent = 'public class Foo { Integer version = 1; }\n';
		const run = await deployedRun(
			{ [`${CLASSES}/Foo.cls`]: oldContent },
			{ [`${CLASSES}/Foo.cls`]: 'public class Foo { Integer version = 2; }\n' },
		);
		const proposal = await buildRollbackProposal({
			repositoryDirectory: fixture?.directory ?? '',
			sourceRun: run,
			currentBaseSha: fixture?.headSha ?? '',
		});

		expect(isOk(proposal)).toBe(true);
		if (!proposal.ok) return;
		expect(proposal.value.plan.components.deployable).toEqual([
			{ type: 'ApexClass', member: 'Foo', change: 'modified' },
		]);
		expect(proposal.value.files).toEqual([
			{
				kind: 'write',
				path: `${CLASSES}/Foo.cls`,
				change: 'modified',
				mode: '100644',
				contents: oldContent,
			},
		]);
	});

	test('a deleted class restores its files and deployable member', async () => {
		const base = {
			[`${CLASSES}/Foo.cls`]: 'public class Foo {}\n',
			[`${CLASSES}/Foo.cls-meta.xml`]: '<ApexClass/>\n',
		};
		const run = await deployedRun(base, {});
		const proposal = await buildRollbackProposal({
			repositoryDirectory: fixture?.directory ?? '',
			sourceRun: run,
			currentBaseSha: fixture?.headSha ?? '',
		});

		expect(isOk(proposal)).toBe(true);
		if (!proposal.ok) return;
		expect(proposal.value.plan.packageXml).toContain('<members>Foo</members>');
		expect(proposal.value.plan.destructiveChangesXml).toBeNull();
		expect(proposal.value.files.map((operation) => operation.kind)).toEqual(['write', 'write']);
		expect(
			proposal.value.files.find((operation) => operation.path.endsWith('Foo.cls')),
		).toMatchObject({ contents: base[`${CLASSES}/Foo.cls`] });
	});
});

describe('M11.5 later-change protection', () => {
	test('a later class edit stops rollback instead of overwriting it', async () => {
		const meta = '<ApexClass/>\n';
		const run = await deployedRun(
			{
				[`${CLASSES}/Foo.cls`]: 'public class Foo { Integer version = 1; }\n',
				[`${CLASSES}/Foo.cls-meta.xml`]: meta,
			},
			{
				[`${CLASSES}/Foo.cls`]: 'public class Foo { Integer version = 2; }\n',
				[`${CLASSES}/Foo.cls-meta.xml`]: meta,
			},
		);
		await writeFile(join(fixture?.directory ?? '', `${CLASSES}/Foo.cls-meta.xml`), '<ApexClass later="true"/>\n');
		const commit = await commitLater(fixture?.directory ?? '');

		const proposal = await buildRollbackProposal({
			repositoryDirectory: fixture?.directory ?? '',
			sourceRun: run,
			currentBaseSha: commit,
		});

		expect(isErr(proposal) && proposal.error.code).toBe('rollback_conflict');
		expect(isErr(proposal) && proposal.error.message).toContain('Foo.cls-meta.xml');
	});
});

describe('M11.6 compensating pull request', () => {
	test('creates one commit whose tree contains only the intended inverse files', async () => {
		const run = await deployedRun(
			{},
			{
				[`${CLASSES}/Foo.cls`]: 'public class Foo {}\n',
				[`${CLASSES}/Foo.cls-meta.xml`]: '<ApexClass/>\n',
				'notes.txt': 'not Salesforce metadata\n',
			},
		);
		const proposal = await buildRollbackProposal({
			repositoryDirectory: fixture?.directory ?? '',
			sourceRun: run,
			currentBaseSha: fixture?.headSha ?? '',
		});
		if (!proposal.ok) throw new Error(proposal.error.message);

		const treeSha = 'c'.repeat(40);
		const commitSha = 'd'.repeat(40);
		const fake = createFakeGitHub({
			'GET /repos/acme/salesforce/git/ref/heads/main': {
				status: 200,
				body: { object: { sha: fixture?.headSha } },
			},
			[`GET /repos/acme/salesforce/git/commits/${fixture?.headSha}`]: {
				status: 200,
				body: { tree: { sha: 'b'.repeat(40) } },
			},
			'POST /repos/acme/salesforce/git/trees': { status: 201, body: { sha: treeSha } },
			'POST /repos/acme/salesforce/git/commits': { status: 201, body: { sha: commitSha } },
			'POST /repos/acme/salesforce/git/refs': {
				status: 201,
				body: {
					ref: `refs/heads/${proposal.value.plan.branch}`,
					object: { sha: commitSha },
				},
			},
			'POST /repos/acme/salesforce/pulls': {
				status: 201,
				body: pullResponse(proposal.value.plan.branch, commitSha),
			},
		});

		const created = await createCompensatingPullRequest(
			{ token: 'scoped', baseUrl: fake.baseUrl, fetch: fake.fetch },
			proposal.value,
		);

		expect(isOk(created) && created.value.number).toBe(77);
		const tree = fake.requests().find((request) => request.path.endsWith('/git/trees'))?.body as {
			tree: readonly Record<string, unknown>[];
		};
		expect(tree.tree).toEqual([
			{ path: `${CLASSES}/Foo.cls`, mode: '100644', type: 'blob', sha: null },
			{ path: `${CLASSES}/Foo.cls-meta.xml`, mode: '100644', type: 'blob', sha: null },
		]);
		expect(JSON.stringify(tree)).not.toContain('notes.txt');
		expect(fake.requests().map((request) => `${request.method} ${request.path}`)).not.toContain(
			'POST /repos/acme/salesforce/deployments',
		);
	});

	test('the CLI verifies the recorded run, writes proposal artifacts, and returns the PR', async () => {
		const run = await deployedRun({}, { [`${CLASSES}/Foo.cls`]: 'public class Foo {}\n' });
		workDirectory = await mkdtemp(join(tmpdir(), 'docket-rollback-cli-'));
		const sourceDirectory = join(workDirectory, 'source');
		if (sourcePlan === undefined) throw new Error('missing source plan');
		const written = await writeRunArtifacts(sourceDirectory, {
			plan: sourcePlan,
			validation: run.validation ?? undefined,
			run,
		});
		if (!written.ok) throw new Error(written.error.message);

		const fake = createFakeGitHub({
			'GET /repos/acme/salesforce/git/ref/heads/main': {
				status: 200,
				body: { object: { sha: fixture?.headSha } },
			},
			[`GET /repos/acme/salesforce/git/commits/${fixture?.headSha}`]: {
				status: 200,
				body: { tree: { sha: 'b'.repeat(40) } },
			},
			'POST /repos/acme/salesforce/git/trees': { status: 201, body: { sha: 'c'.repeat(40) } },
			'POST /repos/acme/salesforce/git/commits': { status: 201, body: { sha: 'd'.repeat(40) } },
			'POST /repos/acme/salesforce/git/refs': {
				status: 201,
				body: {
					ref: `refs/heads/${run.plan.source.pullRequest === 42 ? `docket/rollback-pr42-${run.plan.source.headSha.slice(0, 8)}-${run.plan.source.headSha.slice(0, 8)}` : ''}`,
					object: { sha: 'd'.repeat(40) },
				},
			},
			'POST /repos/acme/salesforce/pulls': {
				status: 201,
				body: pullResponse(
					`docket/rollback-pr42-${run.plan.source.headSha.slice(0, 8)}-${run.plan.source.headSha.slice(0, 8)}`,
					'd'.repeat(40),
				),
			},
		});
		const output = join(workDirectory, 'proposal');

		const outcome = await runCli(
			[
				'rollback',
				'--run', sourceDirectory,
				'--repo', fixture?.directory ?? '',
				'--repository', 'acme/salesforce',
				'--create-pr',
				'--out', output,
				'--json',
			],
			{
				version: '9.9.9',
				cwd: workDirectory,
				env: { GITHUB_TOKEN: 'scoped' },
				now: () => new Date('2026-08-16T10:00:00.000Z'),
				fetch: fake.fetch,
				githubBaseUrl: fake.baseUrl,
			},
		);

		expect(outcome.exitCode).toBe(0);
		expect(JSON.parse(outcome.stdout).data).toMatchObject({
			kind: 'rollback-pr',
			pullRequest: { number: 77 },
		});
		expect(JSON.parse(await readFile(join(output, 'rollback-plan.json'), 'utf8')).identity).toMatch(
			/^sha256:/,
		);
		expect(fake.requests().filter((request) => request.method === 'GET')).toHaveLength(3);
	});

	test('a target branch that moved after calculation causes no GitHub write', async () => {
		const run = await deployedRun({}, { [`${CLASSES}/Foo.cls`]: 'public class Foo {}\n' });
		const proposal = await buildRollbackProposal({
			repositoryDirectory: fixture?.directory ?? '',
			sourceRun: run,
			currentBaseSha: fixture?.headSha ?? '',
		});
		if (!proposal.ok) throw new Error(proposal.error.message);
		const fake = createFakeGitHub({
			'GET /repos/acme/salesforce/git/ref/heads/main': {
				status: 200,
				body: { object: { sha: 'e'.repeat(40) } },
			},
		});

		const created = await createCompensatingPullRequest(
			{ token: 'scoped', baseUrl: fake.baseUrl, fetch: fake.fetch },
			proposal.value,
		);

		expect(isErr(created) && created.error.code).toBe('rollback_conflict');
		expect(fake.requests()).toHaveLength(1);
	});
});

async function commitLater(cwd: string): Promise<string> {
	const env = {
		GIT_AUTHOR_NAME: 'Docket Fixture',
		GIT_AUTHOR_EMAIL: 'fixture@docket.invalid',
		GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z',
		GIT_COMMITTER_NAME: 'Docket Fixture',
		GIT_COMMITTER_EMAIL: 'fixture@docket.invalid',
		GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z',
	};
	for (const args of [['add', '--all'], ['commit', '--quiet', '--message', 'later']] as const) {
		const result = await runGit(args, { cwd, env });
		if (result.exitCode !== 0) throw new Error(result.stderr);
	}
	const sha = await runGit(['rev-parse', 'HEAD'], { cwd });
	return sha.stdout.trim();
}

function pullResponse(branch: string, sha: string): Record<string, unknown> {
	return {
		number: 77,
		html_url: 'https://github.invalid/acme/salesforce/pull/77',
		state: 'open',
		head: { ref: branch, sha, repo: { full_name: 'acme/salesforce' } },
		base: { ref: 'main' },
	};
}
