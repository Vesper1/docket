import { afterEach, describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import {isOk} from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import { deployArgs, runDeployment } from './deploy.ts';
import type { DeployRequest } from './deploy.ts';
import { requireOrgId, resolveOrg } from './org.ts';
import { createFakeSf, failedDeployment, successfulDeployment } from './testing/fake-sf.ts';
import type { FakeSf, FakeSfBehaviour } from './testing/fake-sf.ts';

const REQUEST: DeployRequest = {
	manifestPath: 'manifest/package.xml',
	destructivePath: undefined,
	org: 'docket-qa',
	tests: { mode: 'all' },
	waitMinutes: 33,
};

let fake: FakeSf | undefined;

afterEach(async () => {
	await fake?.remove();
	fake = undefined;
});

const cliFor = async (behaviour: FakeSfBehaviour) => {
	fake = await createFakeSf(behaviour);
	return { executable: fake.executable, cwd: process.cwd() };
};

describe('the deployment arguments', () => {
	test('a validation checks without changing the org', () => {
		expect(deployArgs('validate', REQUEST)).toEqual([
			'project',
			'deploy',
			'validate',
			'--manifest',
			'manifest/package.xml',
			'--target-org',
			'docket-qa',
			'--wait',
			'33',
			'--test-level',
			'RunLocalTests',
		]);
	});

	test('a deployment differs from its validation only in the verb', () => {
		const validation = deployArgs('validate', REQUEST);
		const deployment = deployArgs('deploy', REQUEST);

		expect(deployment[2]).toBe('start');
		expect(deployment.slice(3)).toEqual(validation.slice(3));
	});

	test('an explicit test list is passed class by class', () => {
		const args = deployArgs('validate', {
			...REQUEST,
			tests: { mode: 'specified', classes: ['FooTest', 'BarTest'] },
		});

		expect(args).toContain('RunSpecifiedTests');
		expect(args.filter((arg) => arg === '--tests')).toHaveLength(2);
		expect(args).toContain('FooTest');
		expect(args).toContain('BarTest');
	});

	test('deletions are applied before the deployable manifest', () => {
		const args = deployArgs('deploy', {
			...REQUEST,
			destructivePath: 'manifest/destructiveChanges.xml',
		});

		expect(args).toContain('--pre-destructive-changes');
		expect(args).toContain('manifest/destructiveChanges.xml');
	});
});

describe('running a validation', () => {
	test('a successful validation is parsed into a recordable outcome', async () => {
		const cli = await cliFor({ stdout: successfulDeployment() });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(result).toEqual({
			ok: true,
			value: {
				deploymentId: '0Af000000000001CAA',
				status: 'Succeeded',
				success: true,
				checkOnly: true,
				componentFailures: [],
				tests: { run: 2, failed: 0, failures: [] },
			},
		});
	});

	test('the CLI is asked in JSON, with the arguments the plan requires', async () => {
		const cli = await cliFor({ stdout: successfulDeployment() });

		await runDeployment(cli, 'validate', REQUEST);

		expect((await fake?.invocations()) ?? []).toEqual([
			[...deployArgs('validate', REQUEST), '--json'],
		]);
	});

	test('a failed deployment is an outcome, not a lost error', async () => {
		const cli = await cliFor({ stdout: failedDeployment(), exitCode: 1 });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(isOk(result) && result.value.success).toBe(false);
		expect(isOk(result) && result.value.componentFailures).toEqual([
			{ type: 'ApexClass', member: 'Foo', problem: 'Variable does not exist: bar' },
		]);
		expect(isOk(result) && result.value.tests).toEqual({
			run: 2,
			failed: 1,
			failures: [
				{
					className: 'FooTest',
					method: 'testBar',
					message: 'System.AssertException: Assertion Failed',
				},
			],
		});
	});

	test('a validation response that claims it changed the org is refused', async () => {
		const cli = await cliFor({ stdout: successfulDeployment({ checkOnly: false }) });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
	});

	test('a deployment response that claims check-only is refused', async () => {
		const cli = await cliFor({ stdout: successfulDeployment() });

		const result = await runDeployment(cli, 'deploy', REQUEST);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
	});

	test('a successful result with a failing process exit is contradictory', async () => {
		const cli = await cliFor({ stdout: successfulDeployment(), exitCode: 1 });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
	});

	test('a successful result with a failing envelope status is contradictory', async () => {
		const body = JSON.parse(successfulDeployment());
		body.status = 1;
		const cli = await cliFor({ stdout: JSON.stringify(body) });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
	});

	test('a CLI that answers with something other than JSON is a failure', async () => {
		const cli = await cliFor({ stdout: 'command not found\n', exitCode: 127 });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
	});

	test('a missing Salesforce executable returns a typed failure instead of rejecting', async () => {
		const result = await runDeployment(
			{ executable: 'docket-no-such-salesforce-cli', cwd: process.cwd() },
			'validate',
			REQUEST,
		);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
		expect(errorOf(result).message).toContain('could not start');
	});

	test('noise printed before the JSON does not lose the result', async () => {
		const cli = await cliFor({ stdout: `warning: update available\n${successfulDeployment()}` });

		const result = await runDeployment(cli, 'validate', REQUEST);

		expect(isOk(result) && result.value.deploymentId).toBe('0Af000000000001CAA');
	});

	test('a CLI that never answers is stopped and reported', async () => {
		const cli = await cliFor({ stdout: '', hang: true });

		const result = await runDeployment({ ...cli, timeoutMs: 150 }, 'validate', REQUEST);

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
		expect(errorOf(result).message).toContain('timed out');
	});
});

describe('resolving the target org', () => {
	const org = {
		status: 0,
		result: {
			id: '00D000000000001EAA',
			username: 'qa@docket.invalid',
			instanceUrl: 'https://docket-qa.my.salesforce.com',
			connectedStatus: 'Connected',
		},
	};

	test('a configured alias resolves to the org id a plan is bound to', async () => {
		const cli = await cliFor({ stdout: JSON.stringify(org) });

		const result = await resolveOrg(cli, 'docket-qa');

		expect(result).toEqual({
			ok: true,
			value: {
				reference: 'docket-qa',
				id: '00D000000000001EAA',
				username: 'qa@docket.invalid',
				instanceUrl: 'https://docket-qa.my.salesforce.com',
			},
		});
	});

	test('a disconnected org is refused before anything is planned', async () => {
		const cli = await cliFor({
			stdout: JSON.stringify({
				status: 0,
				result: { ...org.result, connectedStatus: 'RefreshTokenAuthError' },
			}),
		});

		const result = await resolveOrg(cli, 'docket-qa');

		expect(errorOf(result).code).toBe(ErrorCode.orgUnavailable);
	});

	test('an unknown alias is refused', async () => {
		const cli = await cliFor({
			stdout: JSON.stringify({ status: 1, name: 'NamedOrgNotFoundError', message: 'No org found' }),
			exitCode: 1,
		});

		const result = await resolveOrg(cli, 'nope');

		expect(errorOf(result).code).toBe(ErrorCode.orgUnavailable);
	});

	test('an org that is not the validated one is refused', () => {
		const resolved = {
			reference: 'docket-qa',
			id: '00D000000000002EAA',
			username: 'qa@docket.invalid',
			instanceUrl: '',
		};

		expect(isOk(requireOrgId(resolved, '00D000000000002EAA'))).toBe(true);

		const mismatch = requireOrgId(resolved, '00D000000000001EAA');
		expect(errorOf(mismatch).code).toBe(ErrorCode.orgMismatch);
	});
});
