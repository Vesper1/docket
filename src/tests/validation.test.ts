import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runCli } from '../lib/features/cli/cli.ts';
import { ExitCode } from '../lib/features/cli/exit-code.ts';
import { failedDeployment, orgDisplay } from '../lib/features/salesforce/testing/fake-sf.ts';
import { CLASSES, CONFIG, PROJECT, pipelineFixtures, VALIDATION_ID } from './testing/pipeline-fixture.ts';

const { setUp, setUpTree } = pipelineFixtures();

describe('a local validation', () => {
	test('validates the exact plan and records the run', async () => {
		const { context, validation, validated, calls } = await setUp();

		const outcome = await runCli(['validate', ...validation, '--out', validated, '--json'], context);

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
		const { context, validation, validated } = await setUp();

		const outcome = await runCli(
			[
				'validate',
				...validation,
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
		const { context, validation, validated } = await setUp();

		const outcome = await runCli(
			[
				'validate',
				...validation,
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
			['validate', ...validation, '--out', validated, '--artifacts-expire-at', '14 Nov 2026', '--json'],
			context,
		);

		expect(loose.exitCode).toBe(ExitCode.usage);
		expect(JSON.parse(loose.stdout).error.code).toBe('invalid_option');
	});

	test('the artifacts of §6 are on disk, and the plan is the one recorded', async () => {
		const { context, validation, validated } = await setUp();

		await runCli(['validate', ...validation, '--out', validated], context);

		const plan = JSON.parse(await readFile(join(validated, 'plan.json'), 'utf8'));
		const record = JSON.parse(await readFile(join(validated, 'validation.json'), 'utf8'));
		const manifest = await readFile(join(validated, 'package.xml'), 'utf8');

		expect(record.planIdentity).toBe(plan.identity);
		expect(record.verdict).toBe('passed');
		expect(manifest).toContain('<members>Bar</members>');
		expect(await readFile(join(validated, 'report.md'), 'utf8')).toContain('| ApexClass | Bar | added |');
	});

	test('trusted configuration comes from the base commit, not from the change', async () => {
		const { context, planning } = await setUpTree({
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

		const outcome = await runCli(['plan', ...planning, '--json'], context);

		expect(JSON.parse(outcome.stdout).data.plan.target.org).toBe('docket-qa');
	});

	test('a failed Salesforce validation exits non-zero and still records why', async () => {
		const { context, validation, validated } = await setUp({
			behaviour: {
				responses: [
					{ when: ['org', 'display'], stdout: orgDisplay() },
					{ when: ['deploy', 'validate'], stdout: failedDeployment(), exitCode: 1 },
				],
			},
		});

		const outcome = await runCli(['validate', ...validation, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.failure);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.status).toBe('failed');
		expect(data.run.validation.failures).toContain('ApexClass Foo: Variable does not exist: bar');

		const record = JSON.parse(await readFile(join(validated, 'validation.json'), 'utf8'));
		expect(record.verdict).toBe('failed');
	});

	test('a forbidden deletion stops before Salesforce is asked anything', async () => {
		const { context, validation, validated, calls } = await setUp({ deletion: true });

		const outcome = await runCli(['validate', ...validation, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.failure);
		expect(JSON.parse(outcome.stdout).error.code).toBe('destructive_not_allowed');
		expect(await calls()).toEqual(['org display --target-org']);
	});

	test('a wrong target branch is refused', async () => {
		const { context, validation, validated } = await setUp();

		const outcome = await runCli(
			['validate', ...validation, '--out', validated, '--target-branch', 'release/x', '--json'],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('branch_mismatch');
	});
});

describe('a destructive change', () => {
	const PERMISSIVE = CONFIG.replace('allowDestructiveChanges: false', 'allowDestructiveChanges: true');

	test('is planned, manifested and passed to Salesforce once the policy allows it', async () => {
		const { context, validation, validated, invocations } = await setUp({
			config: PERMISSIVE,
			deletion: true,
		});

		const outcome = await runCli(['validate', ...validation, '--out', validated, '--json'], context);

		expect(outcome.exitCode).toBe(ExitCode.success);
		const { data } = JSON.parse(outcome.stdout);
		expect(data.run.plan.components.destructive).toEqual([
			{ type: 'ApexClass', member: 'Foo', change: 'deleted' },
		]);

		const destructive = await readFile(join(validated, 'destructiveChanges.xml'), 'utf8');
		expect(destructive).toContain('<members>Foo</members>');

		const validateCall = (await invocations()).find((argv) => argv.includes('validate')) ?? [];
		expect(validateCall).toContain('--pre-destructive-changes');
	});

	test('the report says plainly what will be deleted', async () => {
		const { context, validation, validated } = await setUp({ config: PERMISSIVE, deletion: true });

		await runCli(['validate', ...validation, '--out', validated], context);

		const report = await readFile(join(validated, 'report.md'), 'utf8');
		expect(report).toContain('## Delete (1)');
		expect(report).toContain('| ApexClass | Foo | deleted |');
		expect(report).toContain('| Destructive changes | allowed |');
	});

	test('turning the policy on changes the plan identity, so old validation cannot stand', async () => {
		const strict = await setUp();
		const first = await runCli(['plan', ...strict.planning, '--json'], strict.context);

		const permissive = await setUp({ config: PERMISSIVE });
		const second = await runCli(['plan', ...permissive.planning, '--json'], permissive.context);

		expect(JSON.parse(first.stdout).data.plan.identity).not.toBe(
			JSON.parse(second.stdout).data.plan.identity,
		);
	});
});
