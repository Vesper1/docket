import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { runCli } from '../cli/cli.ts';
import { ExitCode } from '../cli/exit-code.ts';
import type { EnvironmentConfig } from '../config/docket-config.ts';
import { buildPlan } from '../plan/build-plan.ts';
import { RUN_SCHEMA } from '../run/run-record.ts';
import type { RunKind, RunRecord } from '../run/run-record.ts';
import { writeRunArtifacts } from '../run/write-artifacts.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import { validationRecordOf } from '../validation/validation-record.ts';
import { isErr, isOk } from '../../shared/result/result.ts';
import { selectRollbackSource } from './select-run.ts';

const ENVIRONMENT: EnvironmentConfig = {
	id: 'qa',
	branch: 'main',
	org: 'docket-qa',
	allowDestructiveChanges: false,
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

const DEPLOYMENT: DeploymentOutcome = {
	...VALIDATION,
	deploymentId: '0AfDeployment',
	checkOnly: false,
};

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function recorded(options: { kind?: RunKind; status?: 'passed' | 'failed' } = {}) {
	directory = await mkdtemp(join(tmpdir(), 'docket-rollback-'));
	const plan = buildPlan({
		source: {
			repository: 'acme/salesforce',
			pullRequest: 42,
			baseSha: 'a'.repeat(40),
			headSha: 'b'.repeat(40),
		},
		environment: ENVIRONMENT,
		orgId: '00D000000000001EAA',
		apiVersion: '62.0',
		sourceRoot: 'force-app',
		changes: [{ status: 'added', path: 'force-app/main/default/classes/Foo.cls' }],
	});
	if (!isOk(plan)) throw new Error('expected a plan');

		const validation = validationRecordOf({ plan: plan.value.plan, steps: [], deployment: VALIDATION });
		const kind = options.kind ?? 'deploy';
		const deployment =
			kind === 'validate'
				? null
				: options.status === 'failed'
					? { ...DEPLOYMENT, status: 'Failed', success: false }
					: DEPLOYMENT;
		const run: RunRecord = {
			schema: RUN_SCHEMA,
			kind,
			executor: 'local',
			status: kind === 'validate' ? validation.verdict : (options.status ?? 'passed'),
		timing: {
			startedAt: '2026-08-16T10:00:00.000Z',
			finishedAt: '2026-08-16T10:01:00.000Z',
		},
		plan: plan.value.plan,
		validation,
			deployment,
		steps: [],
		workflow: null,
		mergeCommit: null,
		artifactsExpireAt: null,
	};
	const written = await writeRunArtifacts(directory, { plan: plan.value, validation, run });
	if (!isOk(written)) throw new Error('expected artifacts');
	return { directory, run };
}

describe('M11.1 rollback source selection', () => {
	test('selects one successful regular deployment', async () => {
		const fixture = await recorded();
		const selected = await selectRollbackSource(fixture.directory);

		expect(isOk(selected) && selected.value.deployment?.deploymentId).toBe('0AfDeployment');
	});

	test('a failed or validation-only run cannot start rollback', async () => {
		const failed = await recorded({ status: 'failed' });
		const failedResult = await selectRollbackSource(failed.directory);
		expect(isErr(failedResult) && failedResult.error.code).toBe('rollback_source_invalid');

		await rm(failed.directory, { recursive: true, force: true });
		directory = undefined;
		const validation = await recorded({ kind: 'validate' });
		const validationResult = await selectRollbackSource(validation.directory);
		expect(isErr(validationResult) && validationResult.error.code).toBe('rollback_source_invalid');
	});

	test('an unknown schema is rejected before any inverse plan exists', async () => {
		const fixture = await recorded();
		const path = join(fixture.directory, 'run.json');
		const run = JSON.parse(await readFile(path, 'utf8'));
		run.schema = 'someone.else/v1';
		await writeFile(path, JSON.stringify(run), 'utf8');

		const selected = await selectRollbackSource(fixture.directory);
		expect(isErr(selected) && selected.error.code).toBe('plan_mismatch');
	});

	test('the CLI exposes selection without pretending an inverse was built', async () => {
		const fixture = await recorded();
		const outcome = await runCli(['rollback', '--run', fixture.directory, '--json'], {
			version: '9.9.9',
			cwd: fixture.directory,
			env: {},
			now: () => new Date('2026-08-16T10:00:00.000Z'),
		});

		expect(outcome.exitCode).toBe(ExitCode.success);
		expect(JSON.parse(outcome.stdout).data.kind).toBe('rollback-source');
	});
});
