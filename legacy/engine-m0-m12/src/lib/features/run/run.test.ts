import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import {isOk} from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import { runCli } from '../cli/cli.ts';
import { buildPlan } from '../plan/build-plan.ts';
import type { PlanArtifacts } from '../plan/deployment-plan.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import { validationRecordOf } from '../validation/validation-record.ts';
import { RUN_SCHEMA } from './run-record.ts';
import type { RunRecord } from './run-record.ts';
import { readValidatedRun } from './read-artifacts.ts';
import { findSecrets } from './secret-scan.ts';
import { writeRunArtifacts } from './write-artifacts.ts';
import type { RunArtifacts } from './write-artifacts.ts';

const CLASSES = 'force-app/main/default/classes';

const planArtifacts = (): PlanArtifacts => {
	const result = buildPlan({
		source: {
			repository: 'acme/salesforce',
			pullRequest: 42,
			baseSha: 'a'.repeat(40),
			headSha: 'b'.repeat(40),
		},
		environment: {
			id: 'qa',
			branch: 'main',
			org: 'docket-qa',
			allowDestructiveChanges: false,
			tests: { mode: 'all' },
			gates: [],
			preDeployment: [],
			postDeployment: [],
		},
		orgId: '00D000000000001EAA',
		apiVersion: '62.0',
		sourceRoot: 'force-app',
		changes: [{ status: 'added', path: `${CLASSES}/Foo.cls` }],
	});

	if (!isOk(result)) throw new Error('expected a plan');
	return result.value;
};

const SUCCESS: DeploymentOutcome = {
	deploymentId: '0Af000000000001CAA',
	status: 'Succeeded',
	success: true,
	checkOnly: true,
	componentFailures: [],
	tests: { run: 2, failed: 0, failures: [] },
};

const runArtifacts = (overrides: Partial<RunArtifacts> = {}): RunArtifacts => {
	const plan = overrides.plan ?? planArtifacts();
	const validation =
		overrides.validation ??
		validationRecordOf({ plan: plan.plan, steps: [], deployment: SUCCESS });

	const run: RunRecord = {
		schema: RUN_SCHEMA,
		kind: 'validate',
		executor: 'local',
		status: validation.verdict,
		timing: { startedAt: '2026-08-16T10:00:00.000Z', finishedAt: '2026-08-16T10:04:00.000Z' },
		plan: plan.plan,
		validation,
		deployment: null,
		steps: [],
		workflow: null,
		mergeCommit: null,
		artifactsExpireAt: null,
	};

	return { plan, validation, run, ...overrides };
};

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

const writeInto = async (artifacts: RunArtifacts) => {
	directory = await mkdtemp(join(tmpdir(), 'docket-run-'));
	return { directory, result: await writeRunArtifacts(directory, artifacts) };
};

describe('a validation verdict', () => {
	test('a successful Salesforce validation passes', () => {
		const record = validationRecordOf({
			plan: planArtifacts().plan,
			steps: [],
			deployment: SUCCESS,
		});

		expect(record.verdict).toBe('passed');
		expect(record.failures).toEqual([]);
		expect(record.planIdentity).toBe(planArtifacts().plan.identity);
		expect(record.org).toEqual({ reference: 'docket-qa', id: '00D000000000001EAA' });
	});

	test('a failed test makes the whole verdict fail', () => {
		const record = validationRecordOf({
			plan: planArtifacts().plan,
			steps: [],
			deployment: {
				...SUCCESS,
				status: 'Failed',
				success: false,
				tests: {
					run: 2,
					failed: 1,
					failures: [{ className: 'FooTest', method: 'testBar', message: 'Assertion Failed' }],
				},
			},
		});

		expect(record.verdict).toBe('failed');
		expect(record.failures).toContain('FooTest.testBar: Assertion Failed');
	});

	test('a failed step fails validation before Salesforce is credited', () => {
		const record = validationRecordOf({
			plan: planArtifacts().plan,
			steps: [
				{ name: 'eslint', kind: 'gate', manual: false, status: 'failed', exitCode: 1, completedBy: null },
			],
			deployment: null,
		});

		expect(record.verdict).toBe('failed');
		expect(record.failures).toContain('step `eslint` failed');
	});

	test('no Salesforce answer is a failure, never a silent pass', () => {
		const record = validationRecordOf({ plan: planArtifacts().plan, steps: [], deployment: null });

		expect(record.verdict).toBe('failed');
		expect(record.failures).toEqual(['Salesforce validation did not run']);
	});
});

describe('writing run artifacts', () => {
	test('the §6 layout is written, and only the parts that apply', async () => {
		const { result } = await writeInto(runArtifacts());

		expect(isOk(result) && result.value).toEqual([
			'package.xml',
			'plan.json',
			'report.md',
			'run.json',
			'validation.json',
		]);
	});

	test('run.json holds the plan, the verdict and no credentials', async () => {
		const { directory: written } = await writeInto(runArtifacts());
		const contents = await readFile(join(written, 'run.json'), 'utf8');
		const record = JSON.parse(contents);

		expect(record.schema).toBe(RUN_SCHEMA);
		expect(record.status).toBe('passed');
		expect(record.plan.identity).toMatch(/^sha256:/);
		expect(findSecrets(contents)).toEqual([]);
	});

	test('a destructive manifest appears only when the plan deletes something', async () => {
		const withDeletion = buildPlan({
			source: {
				repository: 'acme/salesforce',
				pullRequest: 42,
				baseSha: 'a'.repeat(40),
				headSha: 'b'.repeat(40),
			},
			environment: {
				id: 'qa',
				branch: 'main',
				org: 'docket-qa',
				allowDestructiveChanges: true,
				tests: { mode: 'all' },
				gates: [],
				preDeployment: [],
				postDeployment: [],
			},
			orgId: '00D000000000001EAA',
			apiVersion: '62.0',
			sourceRoot: 'force-app',
			changes: [{ status: 'deleted', path: `${CLASSES}/Old.cls` }],
		});

		if (!isOk(withDeletion)) throw new Error('expected a plan');

		const { result } = await writeInto(runArtifacts({ plan: withDeletion.value }));

		expect(isOk(result) && result.value).toContain('destructiveChanges.xml');
	});

	test('logs are kept beside the run', async () => {
		const { directory: written, result } = await writeInto(
			runArtifacts({ logs: [{ name: 'validate.log', contents: 'Deploying...\n' }] }),
		);

		expect(isOk(result) && result.value).toContain('logs/validate.log');
		expect(await readdir(join(written, 'logs'))).toEqual(['validate.log']);
	});

	test('writing the same run twice produces identical bytes', async () => {
		const artifacts = runArtifacts();
		const first = await writeInto(artifacts);
		const firstRun = await readFile(join(first.directory, 'run.json'), 'utf8');
		await rm(first.directory, { recursive: true, force: true });

		const second = await writeInto(artifacts);
		const secondRun = await readFile(join(second.directory, 'run.json'), 'utf8');

		expect(firstRun).toBe(secondRun);
	});
});

describe('reading untrusted run artifacts', () => {
	test('accepts a complete, self-consistent validation bundle', async () => {
		const { directory: written } = await writeInto(runArtifacts());

		const result = await readValidatedRun(written);

		expect(isOk(result) && result.value.validation.deployment?.checkOnly).toBe(true);
	});

	test('rejects a passed verdict with no Salesforce validation', async () => {
		const written = await alteredValidation((validation) => {
			validation.deployment = null;
		});

		const result = await readValidatedRun(written);

		expect(errorOf(result).code).toBe(ErrorCode.planMismatch);
	});

	test('rejects a passed verdict whose Salesforce operation was not check-only', async () => {
		const written = await alteredValidation((validation) => {
			validation.deployment.checkOnly = false;
		});

		const result = await readValidatedRun(written);

		expect(errorOf(result).code).toBe(ErrorCode.planMismatch);
	});

	test('rejects malformed nested step evidence even when both files agree', async () => {
		const written = await alteredValidation((validation, run) => {
			validation.steps = [{ name: 'lint', status: 'passed' }];
			run.steps = validation.steps;
		});

		const result = await readValidatedRun(written);

		expect(errorOf(result).code).toBe(ErrorCode.planMismatch);
	});

	test('rejects a plan missing fields below its schema marker', async () => {
		const { directory: written } = await writeInto(runArtifacts());
		const plan = JSON.parse(await readFile(join(written, 'plan.json'), 'utf8'));
		const run = JSON.parse(await readFile(join(written, 'run.json'), 'utf8'));
		delete plan.components;
		delete run.plan.components;
		await writeFile(join(written, 'plan.json'), JSON.stringify(plan), 'utf8');
		await writeFile(join(written, 'run.json'), JSON.stringify(run), 'utf8');

		const result = await readValidatedRun(written);

		expect(errorOf(result).code).toBe(ErrorCode.planMismatch);
	});

	test('rejects a validation bound to another org even when both records agree', async () => {
		const written = await alteredValidation((validation) => {
			validation.org.id = '00D000000000999EAA';
		});

		const result = await readValidatedRun(written);

		expect(errorOf(result).code).toBe(ErrorCode.planMismatch);
	});

	test('inspect-run exposes routing fields only after identity and bundle verification', async () => {
		const artifacts = runArtifacts();
		const { directory: written } = await writeInto(artifacts);
		const outcome = await runCli(
			[
				'inspect-run',
				'--run', written,
				'--expected-plan-identity', artifacts.run.plan.identity,
				'--json',
			],
			{
				version: '9.9.9',
				cwd: written,
				env: {},
				now: () => new Date('2026-08-16T10:00:00.000Z'),
			},
		);

		expect(outcome.exitCode).toBe(0);
		expect(JSON.parse(outcome.stdout).data.run.plan.target.orgId).toBe('00D000000000001EAA');
	});
});

const alteredValidation = async (
	alter: (validation: any, run: any) => void,
): Promise<string> => {
	const { directory: written } = await writeInto(runArtifacts());
	const validation = JSON.parse(await readFile(join(written, 'validation.json'), 'utf8'));
	const run = JSON.parse(await readFile(join(written, 'run.json'), 'utf8'));
	alter(validation, run);
	run.validation = validation;
	await writeFile(join(written, 'validation.json'), JSON.stringify(validation), 'utf8');
	await writeFile(join(written, 'run.json'), JSON.stringify(run), 'utf8');
	return written;
};

describe('the secret scan', () => {
	test('credential shapes are found', () => {
		const samples = [
			'00D5f000000ZzZzEAK!AQoAQKrtaLd5H2Y3mQ8pF2sample_token_value',
			'force://PlatformCLI::5Aep861_token@my-org.my.salesforce.com',
			'-----BEGIN RSA PRIVATE KEY-----',
			'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'AKIAIOSFODNN7EXAMPLE',
			'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc',
			'client_secret: 6f2b9d4c1a',
		];

		for (const sample of samples) expect(findSecrets(sample)).not.toEqual([]);
	});

	test('a finding names the rule and the line but never quotes the secret', () => {
		const findings = findSecrets('fine\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n');

		expect(findings).toEqual([{ rule: 'GitHub token', line: 2 }]);
	});

	test('the public identifiers a plan is made of are not secrets', () => {
		const plan = planArtifacts();

		expect(findSecrets(JSON.stringify(plan.plan))).toEqual([]);
		expect(findSecrets('00D000000000001EAA')).toEqual([]);
		expect(findSecrets('0Af000000000001CAA')).toEqual([]);
	});

	test('an artifact with a secret in it is not written at all', async () => {
		const artifacts = runArtifacts();
		const { directory: written, result } = await writeInto({
			...artifacts,
			logs: [{ name: 'validate.log', contents: 'sfdxAuthUrl force://PlatformCLI::token@example' }],
		});

		expect(errorOf(result).code).toBe(ErrorCode.secretInArtifact);
		expect(await readdir(written)).toEqual([]);
	});
});
