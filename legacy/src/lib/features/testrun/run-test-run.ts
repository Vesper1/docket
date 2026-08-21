import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DocketError } from '../../shared/result/docket-error.ts';
import { ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME, parseConfig } from '../config/config.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { runApexTests } from '../salesforce/apex-test.ts';
import type { ApexTestOutcome, ClassCoverage } from '../salesforce/apex-test.ts';
import { resolveOrg } from '../salesforce/org.ts';
import type { ResolvedOrg } from '../salesforce/org.ts';

/** File names inside the output directory. */
export const TEST_RUN_ARTIFACT_NAMES = {
	tests: 'tests.json',
	report: 'report.md',
} as const;

export interface TestRunRequest {
	/** The git repository the commit already exists in. */
	readonly repositoryDirectory: string;
	/** The commit whose `docket.yml` names the org. */
	readonly sha: string;
	readonly outputDirectory: string;
	readonly executable: string;
	readonly waitMinutes: number;
	/**
	 * Lowest per-class coverage the run accepts, or `null` to report without
	 * holding anything to a number.
	 */
	readonly minCoveragePercent: number | null;
	readonly signal?: AbortSignal;
}

export interface TestRunOutcome {
	readonly status: 'passed' | 'failed';
	readonly org: ResolvedOrg;
	readonly sha: string;
	readonly tests: ApexTestOutcome;
	readonly minCoveragePercent: number | null;
	/** Classes with executable lines that fall below the configured minimum. */
	readonly belowMinimum: readonly ClassCoverage[];
	/** Why the run failed, in the order the reasons were found. */
	readonly failures: readonly string[];
	readonly directory: string;
}

/**
 * Runs every local Apex test in the configured org and records the result.
 *
 * This is not a deployment and not a gate: it deploys nothing, reads no diff
 * and takes no commit pair. It answers one question — what is the state of the
 * org's own test suite right now — which no per-change check can answer,
 * because a class whose tests were deleted appears in nobody's diff.
 *
 * Nothing is exported into a workspace: the tests being run are the ones the
 * org already holds, not the ones in any commit.
 */
export const runTestRun = async (request: TestRunRequest): Promise<Result<TestRunOutcome, DocketError>> => {
	const config = await readFileAtCommit({
		cwd: request.repositoryDirectory,
		sha: request.sha,
		path: CONFIG_FILE_NAME,
	});
	if (!config.ok) return config;

	const parsed = parseConfig(config.value);
	if (!parsed.ok) return parsed;

	const cli = {
		executable: request.executable,
		cwd: request.repositoryDirectory,
		timeoutMs: (request.waitMinutes + GRACE_MINUTES) * 60_000,
		...(request.signal === undefined ? {} : { signal: request.signal }),
	};

	// Resolved before the suite runs, so a stale login fails in seconds rather
	// than after an hour of tests.
	const org = await resolveOrg(cli, parsed.value.org);
	if (!org.ok) return org;

	const tests = await runApexTests(cli, {
		org: parsed.value.org,
		waitMinutes: request.waitMinutes,
	});
	if (!tests.ok) return tests;

	const belowMinimum = belowMinimumOf(tests.value.coverage, request.minCoveragePercent);
	const failures = failuresOf(tests.value, belowMinimum, request.minCoveragePercent);

	const outcome: TestRunOutcome = {
		status: failures.length === 0 ? 'passed' : 'failed',
		org: org.value,
		sha: request.sha,
		tests: tests.value,
		minCoveragePercent: request.minCoveragePercent,
		belowMinimum,
		failures,
		directory: request.outputDirectory,
	};

	await write(
		join(request.outputDirectory, TEST_RUN_ARTIFACT_NAMES.tests),
		`${JSON.stringify(resultDocument(outcome), null, '\t')}\n`,
	);
	await write(join(request.outputDirectory, TEST_RUN_ARTIFACT_NAMES.report), renderTestReport(outcome));

	return ok(outcome);
};

/** How long past the CLI's own wait the process is allowed to live. */
const GRACE_MINUTES = 5;

/**
 * A class with no executable lines is not undertested; it has nothing to test.
 * Holding an interface to 85% would make the threshold unusable and teach
 * everyone to turn it off.
 */
const belowMinimumOf = (
	coverage: readonly ClassCoverage[],
	minimum: number | null,
): readonly ClassCoverage[] => {
	if (minimum === null) return [];

	return coverage.filter((entry) => entry.percent !== null && entry.percent < minimum);
};

const failuresOf = (
	tests: ApexTestOutcome,
	belowMinimum: readonly ClassCoverage[],
	minimum: number | null,
): readonly string[] => {
	const failures: string[] = [];

	for (const failure of tests.failures) {
		failures.push(`${failure.className}.${failure.method}: ${failure.message}`);
	}

	// A suite can report `Failed` for a reason that produced no per-test row —
	// a compile error in a test class. The verdict still stands on its own.
	if (!tests.passed && failures.length === 0) {
		failures.push(`Salesforce reported ${tests.outcome}`);
	}

	if (minimum !== null) {
		for (const entry of belowMinimum) {
			failures.push(`${entry.name} is at ${format(entry.percent)}, below the ${String(minimum)}% minimum`);
		}
	}

	return failures;
};

/** The record on disk. No source bytes, no secrets — counts and names only. */
const resultDocument = (outcome: TestRunOutcome) => ({
	status: outcome.status,
	sha: outcome.sha,
	org: { reference: outcome.org.reference, id: outcome.org.id, instanceUrl: outcome.org.instanceUrl },
	testRunId: outcome.tests.testRunId,
	outcome: outcome.tests.outcome,
	ran: outcome.tests.ran,
	passing: outcome.tests.passing,
	failing: outcome.tests.failing,
	skipped: outcome.tests.skipped,
	orgWideCoveragePercent: outcome.tests.orgWideCoveragePercent,
	minCoveragePercent: outcome.minCoveragePercent,
	failures: outcome.failures,
	coverage: outcome.tests.coverage,
});

/**
 * The report, as Markdown.
 *
 * Written for `$GITHUB_STEP_SUMMARY` as much as for a terminal: a weekly run
 * nobody opens is a weekly run that changes nothing, so the numbers have to be
 * on the job page rather than inside a downloadable artifact.
 */
export const renderTestReport = (outcome: TestRunOutcome): string => {
	const { tests } = outcome;
	const lines = [
		`# Apex test run — ${outcome.status}`,
		'',
		`- org: \`${outcome.org.reference}\` (${outcome.org.id})`,
		`- run: \`${tests.testRunId}\``,
		`- tests: ${String(tests.ran)} run, ${String(tests.passing)} passing, ${String(tests.failing)} failing, ${String(tests.skipped)} skipped`,
		`- org-wide coverage: ${format(tests.orgWideCoveragePercent)}`,
		'',
	];

	if (tests.failures.length > 0) {
		lines.push('## Failing tests', '');
		for (const failure of tests.failures) {
			lines.push(`- \`${failure.className}.${failure.method}\` — ${failure.message}`);
		}
		lines.push('');
	}

	if (outcome.minCoveragePercent !== null) {
		lines.push(`## Coverage below ${String(outcome.minCoveragePercent)}%`, '');
		if (outcome.belowMinimum.length === 0) {
			lines.push('None.', '');
		} else {
			lines.push('| Class | Covered | Lines | Coverage |', '| --- | ---: | ---: | ---: |');
			for (const entry of outcome.belowMinimum) {
				lines.push(
					`| \`${entry.name}\` | ${String(entry.coveredLines)} | ${String(entry.totalLines)} | ${format(entry.percent)} |`,
				);
			}
			lines.push('');
		}
	}

	const untestable = tests.coverage.filter((entry) => entry.percent === null).length;
	lines.push(
		`${String(tests.coverage.length)} classes reported coverage; ${String(untestable)} have no executable lines.`,
		'',
	);

	return lines.join('\n');
};

const format = (percent: number | null): string =>
	percent === null ? 'not reported' : `${percent.toFixed(1)}%`;

const write = async (path: string, contents: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, 'utf8');
};
