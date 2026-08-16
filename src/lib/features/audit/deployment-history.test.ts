import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { isErr, isOk } from '../../shared/result/result.ts';
import { runCli } from '../cli/cli.ts';
import type { EnvironmentConfig } from '../config/docket-config.ts';
import { buildPlan } from '../plan/build-plan.ts';
import { RUN_SCHEMA } from '../run/run-record.ts';
import type { RunRecord } from '../run/run-record.ts';
import { writeRunArtifacts } from '../run/write-artifacts.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import { validationRecordOf } from '../validation/validation-record.ts';
import { buildDeploymentHistory } from './deployment-history.ts';

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

let root: string | undefined;

afterEach(async () => {
	if (root !== undefined) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function recorded(
	name: string,
	options: {
		readonly pullRequest: number;
		readonly finishedAt: string;
		readonly workflowRunId?: string;
		readonly failed?: boolean;
		readonly expiry?: string | null;
	},
): Promise<string> {
	root ??= await mkdtemp(join(tmpdir(), 'docket-history-'));
	const directory = join(root, name);
	const digit = String(options.pullRequest % 10);
	const plan = buildPlan({
		source: {
			repository: 'acme/salesforce',
			pullRequest: options.pullRequest,
			baseSha: digit.repeat(40),
			headSha: (digit === '9' ? 'a' : String(Number(digit) + 1)).repeat(40),
		},
		environment: ENVIRONMENT,
		orgId: '00D000000000001EAA',
		apiVersion: '62.0',
		sourceRoot: 'force-app',
		changes: [
			{
				status: 'added',
				path: `force-app/main/default/classes/Foo${options.pullRequest}.cls`,
			},
		],
	});
	if (!isOk(plan)) throw new Error('expected plan');

	const validationDeployment: DeploymentOutcome = {
		deploymentId: `0AfValidation${options.pullRequest}`,
		status: 'Succeeded',
		success: true,
		checkOnly: true,
		componentFailures: [],
		tests: { run: 1, failed: 0, failures: [] },
	};
	const validation = validationRecordOf({
		plan: plan.value.plan,
		steps: [],
		deployment: validationDeployment,
	});
	const deployment: DeploymentOutcome = options.failed
		? {
				...validationDeployment,
				deploymentId: `0AfDeployment${options.pullRequest}`,
				status: 'Failed',
				success: false,
				checkOnly: false,
				componentFailures: [
					{ type: 'ApexClass', member: `Foo${options.pullRequest}`, problem: 'compile failed' },
				],
			}
		: {
				...validationDeployment,
				deploymentId: `0AfDeployment${options.pullRequest}`,
				checkOnly: false,
			};
	const workflow =
		options.workflowRunId === undefined
			? null
			: { runId: options.workflowRunId, runAttempt: 1 };
	const run: RunRecord = {
		schema: RUN_SCHEMA,
		kind: 'deploy',
		executor: workflow === null ? 'local' : 'github-actions',
		status: options.failed ? 'failed' : 'passed',
		timing: { startedAt: '2026-08-16T10:00:00.000Z', finishedAt: options.finishedAt },
		plan: plan.value.plan,
		validation,
		deployment,
		steps: [],
		workflow,
		mergeCommit: 'f'.repeat(40),
		artifactsExpireAt: options.expiry ?? null,
	};
	const written = await writeRunArtifacts(directory, { plan: plan.value, validation, run });
	if (!written.ok) throw new Error(written.error.message);
	return directory;
}

describe('M12.3 deployment history', () => {
	test('traces PR, SHAs, org, validation, deployment and workflow from verified artifacts', async () => {
		await recorded('older', {
			pullRequest: 41,
			finishedAt: '2026-08-16T10:02:00.000Z',
			expiry: '2026-09-15T10:02:00.000Z',
		});
		await recorded('newer', {
			pullRequest: 42,
			finishedAt: '2026-08-16T11:02:00.000Z',
			workflowRunId: '9001',
			failed: true,
		});

		const history = await buildDeploymentHistory(root ?? '');

		expect(isOk(history)).toBe(true);
		if (!history.ok) return;
		expect(history.value.entries.map((entry) => entry.pullRequest)).toEqual([42, 41]);
		expect(history.value.entries[0]).toMatchObject({
			status: 'failed',
			repository: 'acme/salesforce',
			pullRequest: 42,
			mergeCommit: 'f'.repeat(40),
			environment: { id: 'qa', org: 'docket-qa', orgId: '00D000000000001EAA' },
			validation: { verdict: 'passed', deploymentId: '0AfValidation42' },
			deployment: { deploymentId: '0AfDeployment42', status: 'Failed', success: false },
			workflow: { runId: '9001', runAttempt: 1 },
		});
		expect(history.value.entries[0]?.baseSha).toHaveLength(40);
		expect(history.value.entries[0]?.headSha).toHaveLength(40);
		expect(history.value.retention).toEqual({
			boundedByArtifacts: true,
			earliestKnownExpiry: '2026-09-15T10:02:00.000Z',
			unknownExpiryEntries: 1,
		});
	});

	test('one malformed bundle fails the history instead of disappearing from it', async () => {
		const directory = await recorded('tampered', {
			pullRequest: 42,
			finishedAt: '2026-08-16T11:02:00.000Z',
		});
		const path = join(directory, 'run.json');
		const run = JSON.parse(await readFile(path, 'utf8'));
		run.plan.target.orgId = 'org-id\nforged-output=yes';
		await writeFile(path, JSON.stringify(run), 'utf8');

		const history = await buildDeploymentHistory(root ?? '');

		expect(isErr(history) && history.error.code).toBe('history_invalid');
	});

	test('the CLI writes a deterministic JSON and Markdown projection', async () => {
		await recorded('run', {
			pullRequest: 42,
			finishedAt: '2026-08-16T11:02:00.000Z',
			workflowRunId: '9001',
		});
		const output = join(root ?? '', 'projection');

		const result = await runCli(['history', '--runs', root ?? '', '--out', output, '--json'], {
			version: '9.9.9',
			cwd: root ?? '',
			env: {},
			now: () => new Date('2026-08-16T12:00:00.000Z'),
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).data.history.entries).toHaveLength(1);
		expect(JSON.parse(await readFile(join(output, 'history.json'), 'utf8')).schema).toBe(
			'docket.deployment-history/v1',
		);
		expect(await readFile(join(output, 'history.md'), 'utf8')).toContain('0AfDeployment42');
	});
});
