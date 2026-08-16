import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { TestSelection } from '../config/docket-config.ts';
import { runSf } from './sf-cli.ts';
import type { SalesforceCli } from './sf-cli.ts';

export interface DeployRequest {
	/** Path to `package.xml`, relative to the CLI working directory or absolute. */
	readonly manifestPath: string;
	/** Path to `destructiveChanges.xml`, when the plan deletes something. */
	readonly destructivePath: string | undefined;
	/** Org alias or username, never a credential. */
	readonly org: string;
	readonly tests: TestSelection;
	/** How long the CLI waits for Salesforce before giving up. */
	readonly waitMinutes: number;
}

/**
 * A validation checks the deployment without changing the org; a deployment
 * changes it. Everything else about the two is identical, which is the point:
 * what was validated is what gets deployed.
 */
export type DeployMode = 'validate' | 'deploy';

/** One Salesforce deployment, as Docket records it. */
export interface DeploymentOutcome {
	/** The Salesforce deployment id — the org's own record of this operation. */
	readonly deploymentId: string;
	/** Salesforce's status word, e.g. `Succeeded`, `Failed`, `Canceled`. */
	readonly status: string;
	readonly success: boolean;
	readonly checkOnly: boolean;
	readonly componentFailures: readonly ComponentFailure[];
	readonly tests: TestOutcome;
}

export interface ComponentFailure {
	readonly type: string;
	readonly member: string;
	readonly problem: string;
}

export interface TestOutcome {
	readonly run: number;
	readonly failed: number;
	readonly failures: readonly TestFailure[];
}

export interface TestFailure {
	readonly className: string;
	readonly method: string;
	readonly message: string;
}

/**
 * Builds the CLI arguments for a validation or a deployment.
 *
 * Exported because the arguments are part of the contract a plan promises: a
 * deployment must be able to prove it used the manifests and test selection
 * that validation approved.
 */
export function deployArgs(mode: DeployMode, request: DeployRequest): readonly string[] {
	const args = [
		'project',
		'deploy',
		mode === 'validate' ? 'validate' : 'start',
		'--manifest',
		request.manifestPath,
		'--target-org',
		request.org,
		'--wait',
		String(request.waitMinutes),
	];

	if (request.destructivePath !== undefined) {
		// The destructive manifest is applied before the deployable one, so a
		// deleted component cannot collide with one being deployed.
		args.push('--pre-destructive-changes', request.destructivePath);
	}

	if (request.tests.mode === 'all') {
		// Local tests, not `RunAllTestsInOrg`: managed-package tests belong to
		// their vendor and would fail a deployment for reasons nobody here owns.
		args.push('--test-level', 'RunLocalTests');
	} else {
		args.push('--test-level', 'RunSpecifiedTests');
		for (const className of request.tests.classes) args.push('--tests', className);
	}

	return args;
}

/**
 * Runs the deployment and reads back what Salesforce did.
 *
 * A failed deployment returns a successful `Result` carrying `success: false`:
 * the run must record the component and test failures, and a thrown-away error
 * string would lose exactly the detail a developer needs.
 */
export async function runDeployment(
	cli: SalesforceCli,
	mode: DeployMode,
	request: DeployRequest,
): Promise<Result<DeploymentOutcome, DocketError>> {
	const envelope = await runSf(cli, deployArgs(mode, request));
	if (!envelope.ok) return envelope;

	const result = asRecord(envelope.value.result);
	if (result === undefined) {
		const detail = envelope.value.message ?? `sf exited ${envelope.value.exitCode}`;
		return err(docketError(ErrorCode.salesforceFailed, `Salesforce returned no result: ${detail}`));
	}

	const deploymentId = typeof result['id'] === 'string' ? result['id'] : undefined;
	if (deploymentId === undefined) {
		return err(
			docketError(ErrorCode.salesforceFailed, 'Salesforce returned a deployment without an id'),
		);
	}

	const status = typeof result['status'] === 'string' ? result['status'] : 'Unknown';
	const reportedSuccess = result['success'];
	const checkOnly = result['checkOnly'];
	if (typeof reportedSuccess !== 'boolean' || typeof checkOnly !== 'boolean') {
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				'Salesforce returned a deployment without boolean success/checkOnly fields',
			),
		);
	}

	const expectedCheckOnly = mode === 'validate';
	if (checkOnly !== expectedCheckOnly) {
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				`Salesforce answered ${mode} with checkOnly=${String(checkOnly)}`,
			),
		);
	}

	const statusSucceeded = status === 'Succeeded';
	if (reportedSuccess !== statusSucceeded) {
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				`Salesforce returned contradictory success=${String(reportedSuccess)} and status=${status}`,
			),
		);
	}

	const cliSucceeded = envelope.value.status === 0 && envelope.value.exitCode === 0;
	if (reportedSuccess !== cliSucceeded) {
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				`Salesforce result disagrees with CLI status ${envelope.value.status} and exit ${envelope.value.exitCode}`,
			),
		);
	}

	const details = asRecord(result['details']) ?? {};

	return ok({
		deploymentId,
		status,
		success: reportedSuccess,
		checkOnly,
		componentFailures: componentFailures(details['componentFailures']),
		tests: testOutcome(details['runTestResult']),
	});
}

function componentFailures(raw: unknown): readonly ComponentFailure[] {
	return asArray(raw).flatMap((entry) => {
		const failure = asRecord(entry);
		if (failure === undefined) return [];

		return [
			{
				type: text(failure['componentType']) || 'Unknown',
				member: text(failure['fullName']) || text(failure['name']) || 'Unknown',
				problem: text(failure['problem']) || 'no detail reported',
			},
		];
	});
}

function testOutcome(raw: unknown): TestOutcome {
	const tests = asRecord(raw);
	if (tests === undefined) return { run: 0, failed: 0, failures: [] };

	return {
		run: count(tests['numTestsRun']),
		failed: count(tests['numFailures']),
		failures: asArray(tests['failures']).flatMap((entry) => {
			const failure = asRecord(entry);
			if (failure === undefined) return [];

			return [
				{
					className: text(failure['name']) || 'Unknown',
					method: text(failure['methodName']) || 'Unknown',
					message: text(failure['message']) || 'no detail reported',
				},
			];
		}),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Salesforce collapses a one-element list into the element itself. */
function asArray(value: unknown): readonly unknown[] {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null ? [] : [value];
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
