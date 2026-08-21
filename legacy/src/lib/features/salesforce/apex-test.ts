import { asRecord } from '../../shared/json/read-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { runSf } from './sf-cli.ts';
import type { SalesforceCli } from './sf-cli.ts';

export interface ApexTestRequest {
	/** Org alias or username, never a credential. */
	readonly org: string;
	/** How long the CLI waits for the org before giving up. */
	readonly waitMinutes: number;
}

export interface ApexTestFailure {
	readonly className: string;
	readonly method: string;
	readonly message: string;
}

/**
 * How much of one class the run executed.
 *
 * `percent` is computed here rather than read back, because the org rounds its
 * own number and a threshold must not turn on a rounding decision. A class with
 * no executable lines — an interface, a constant holder — reports `null` and is
 * never held to a minimum it cannot meet.
 */
export interface ClassCoverage {
	readonly name: string;
	readonly coveredLines: number;
	readonly totalLines: number;
	readonly percent: number | null;
}

/** One full Apex test run, as Docket records it. */
export interface ApexTestOutcome {
	/** The org's own record of this run. */
	readonly testRunId: string;
	/** Salesforce's word for the verdict, e.g. `Passed`, `Failed`. */
	readonly outcome: string;
	readonly passed: boolean;
	readonly ran: number;
	readonly passing: number;
	readonly failing: number;
	readonly skipped: number;
	/** The org-wide figure Salesforce enforces at 75%, or `null` if absent. */
	readonly orgWideCoveragePercent: number | null;
	readonly failures: readonly ApexTestFailure[];
	readonly coverage: readonly ClassCoverage[];
}

/**
 * Builds the CLI arguments for a full test run.
 *
 * `RunLocalTests`, not `RunAllTestsInOrg`: managed-package tests belong to
 * their vendor and would fail a run for reasons nobody here owns — the same
 * choice a deployment makes under `tests: all`.
 */
export const apexTestArgs = (request: ApexTestRequest): readonly string[] => [
	'apex',
	'run',
	'test',
	'--target-org',
	request.org,
	'--test-level',
	'RunLocalTests',
	'--code-coverage',
	'--result-format',
	'json',
	'--wait',
	String(request.waitMinutes),
];

/**
 * Runs every local test in the org and reads back what happened.
 *
 * A failing suite returns a successful `Result` carrying `passed: false`: the
 * failures are the most valuable thing in the run, and collapsing them into an
 * error string would throw away exactly what someone needs to read.
 */
export const runApexTests = async (
	cli: SalesforceCli,
	request: ApexTestRequest,
): Promise<Result<ApexTestOutcome, DocketError>> => {
	const envelope = await runSf(cli, apexTestArgs(request));
	if (!envelope.ok) return envelope;

	const result = asRecord(envelope.value.result);
	if (result === undefined) {
		const detail = envelope.value.message ?? `sf exited ${envelope.value.exitCode}`;
		return err(docketError(ErrorCode.salesforceFailed, `Salesforce returned no test result: ${detail}`));
	}

	const summary = asRecord(result['summary']);
	if (summary === undefined) {
		return err(docketError(ErrorCode.salesforceFailed, 'Salesforce returned a test run without a summary'));
	}

	const testRunId = text(summary['testRunId']);
	if (testRunId === '') {
		return err(docketError(ErrorCode.salesforceFailed, 'Salesforce returned a test run without an id'));
	}

	const outcome = text(summary['outcome']) || 'Unknown';
	const failing = count(summary['failing']);

	// Two independent statements of the same fact. When they disagree, Docket
	// does not get to pick the convenient one.
	const passed = outcome === 'Passed';
	if (passed !== (failing === 0)) {
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				`Salesforce returned outcome ${outcome} with ${String(failing)} failing tests`,
			),
		);
	}

	return ok({
		testRunId,
		outcome,
		passed,
		ran: count(summary['testsRan']),
		passing: count(summary['passing']),
		failing,
		skipped: count(summary['skipped']),
		orgWideCoveragePercent: percentOf(summary['orgWideCoverage']),
		failures: failuresOf(result['tests']),
		coverage: coverageOf(result['codecoverage'] ?? result['coverage']),
	});
};

const failuresOf = (raw: unknown): readonly ApexTestFailure[] =>
	asArray(raw).flatMap((entry) => {
		const test = asRecord(entry);
		if (test === undefined || text(test['Outcome']) !== 'Fail') return [];

		return [
			{
				className: text(asRecord(test['ApexClass'])?.['Name']) || text(test['FullName']) || 'Unknown',
				method: text(test['MethodName']) || 'Unknown',
				message: text(test['Message']) || 'no detail reported',
			},
		];
	});

const coverageOf = (raw: unknown): readonly ClassCoverage[] =>
	asArray(raw)
		.flatMap((entry) => {
			const row = asRecord(entry);
			if (row === undefined) return [];

			const name = text(row['name']) || text(row['ApexClassOrTriggerName']);
			if (name === '') return [];

			const totalLines = count(row['totalLines']);
			const coveredLines = count(row['totalCovered']);

			return [
				{
					name,
					coveredLines,
					totalLines,
					percent: totalLines === 0 ? null : (coveredLines / totalLines) * 100,
				},
			];
		})
		// Sorted so two runs of the same org produce comparable artifacts.
		.sort((left, right) => left.name.localeCompare(right.name));

/** Salesforce writes this one as `"85%"`, not as a number. */
const percentOf = (value: unknown): number | null => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string') return null;

	const parsed = Number(value.replace('%', '').trim());
	return Number.isFinite(parsed) ? parsed : null;
};

/** Salesforce collapses a one-element list into the element itself. */
const asArray = (value: unknown): readonly unknown[] => {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null ? [] : [value];
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
