import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { errorOf } from '../../shared/result/testing/expect-result.ts';
import { ErrorCode } from '../../shared/result/docket-error.ts';
import { createGitFixture } from '../git/testing/git-fixture.ts';
import { apexTestArgs } from '../salesforce/apex-test.ts';
import { apexTestRun, createFakeSf, orgDisplay } from '../salesforce/testing/fake-sf.ts';
import { runTestRun } from './run-test-run.ts';
import type { TestRunOutcome } from './run-test-run.ts';

const CONFIG = ['version: 1', 'org: docket-qa', 'tests: all', ''].join('\n');

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * One test run against a real spawned CLI and a real repository. What no
 * fixture can prove is that Salesforce accepts the arguments — only a live org
 * can.
 */
const runOf = async (
	testRun: string,
	options: { readonly minCoveragePercent?: number | null; readonly config?: string } = {},
) => {
	const fixture = await createGitFixture({
		base: { 'docket.yml': options.config ?? CONFIG },
		head: { 'docket.yml': options.config ?? CONFIG },
	});
	cleanups.push(fixture.remove);

	const fake = await createFakeSf({
		responses: [
			{ when: ['org', 'display'], stdout: orgDisplay() },
			{ when: ['apex', 'run', 'test'], stdout: testRun },
		],
	});
	cleanups.push(fake.remove);

	const directory = await mkdtemp(join(tmpdir(), 'docket-out-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));

	const result = await runTestRun({
		repositoryDirectory: fixture.directory,
		sha: fixture.headSha,
		outputDirectory: directory,
		executable: fake.executable,
		waitMinutes: 1,
		minCoveragePercent: options.minCoveragePercent ?? null,
	});

	return { result, directory, invocations: fake.invocations };
};

describe('the test run arguments', () => {
	test('every local test runs with coverage', () => {
		expect(apexTestArgs({ org: 'docket-qa', waitMinutes: 33 })).toEqual([
			'apex',
			'run',
			'test',
			'--target-org',
			'docket-qa',
			'--test-level',
			'RunLocalTests',
			'--code-coverage',
			'--result-format',
			'json',
			'--wait',
			'33',
		]);
	});

	test('managed-package tests are never included', () => {
		expect(apexTestArgs({ org: 'docket-qa', waitMinutes: 1 })).not.toContain('RunAllTestsInOrg');
	});
});

describe('a passing run', () => {
	test('records the org, the run id and the counts', async () => {
		const { result } = await runOf(apexTestRun());

		expect(result.ok).toBe(true);
		const outcome = (result as { value: TestRunOutcome }).value;
		expect(outcome.status).toBe('passed');
		expect(outcome.tests.testRunId).toBe('707000000000001AAA');
		expect(outcome.tests.ran).toBe(2);
		expect(outcome.org.id).toBe('00D000000000001EAA');
	});

	test('writes tests.json and a report without source bytes', async () => {
		const { directory } = await runOf(apexTestRun());

		const tests: unknown = JSON.parse(await readFile(join(directory, 'tests.json'), 'utf8'));
		expect(tests).toMatchObject({ status: 'passed', orgWideCoveragePercent: 84 });

		const report = await readFile(join(directory, 'report.md'), 'utf8');
		expect(report).toContain('Apex test run — passed');
		expect(report).toContain('84.0%');
	});

	test('resolves the org before spending an hour on tests', async () => {
		const { invocations } = await runOf(apexTestRun());

		const calls = await invocations();
		expect(calls[0]?.slice(0, 2)).toEqual(['org', 'display']);
		expect(calls[1]?.slice(0, 3)).toEqual(['apex', 'run', 'test']);
	});
});

describe('a failing run', () => {
	test('names every failing test', async () => {
		const { result } = await runOf(
			apexTestRun({
				summary: { outcome: 'Failed', failing: 1, passing: 1 },
				tests: [
					{
						ApexClass: { Name: 'GreeterTest' },
						MethodName: 'greets',
						Outcome: 'Fail',
						Message: 'System.AssertException: Assertion Failed',
					},
				],
			}),
		);

		const outcome = (result as { value: TestRunOutcome }).value;
		expect(outcome.status).toBe('failed');
		expect(outcome.failures).toEqual([
			'GreeterTest.greets: System.AssertException: Assertion Failed',
		]);
	});

	// A test class that will not compile fails the suite while producing no
	// per-test row at all, and the run must still say so.
	test('reports a verdict that produced no per-test rows', async () => {
		const { result } = await runOf(
			apexTestRun({ summary: { outcome: 'Failed', failing: 1, passing: 0 }, tests: [] }),
		);

		const outcome = (result as { value: TestRunOutcome }).value;
		expect(outcome.status).toBe('failed');
		expect(outcome.failures).toEqual(['Salesforce reported Failed']);
	});

	test('refuses a verdict that contradicts its own failure count', async () => {
		const { result } = await runOf(apexTestRun({ summary: { outcome: 'Passed', failing: 3 } }));

		expect(errorOf(result).code).toBe(ErrorCode.salesforceFailed);
	});
});

describe('the coverage minimum', () => {
	test('fails a class below it', async () => {
		const { result } = await runOf(
			apexTestRun({ codecoverage: [{ name: 'Greeter', totalLines: 10, totalCovered: 4 }] }),
			{ minCoveragePercent: 85 },
		);

		const outcome = (result as { value: TestRunOutcome }).value;
		expect(outcome.status).toBe('failed');
		expect(outcome.belowMinimum.map((entry) => entry.name)).toEqual(['Greeter']);
		expect(outcome.failures[0]).toBe('Greeter is at 40.0%, below the 85% minimum');
	});

	// An interface has nothing to cover. Holding it to a minimum would make the
	// threshold unusable and teach everyone to turn it off.
	test('ignores a class with no executable lines', async () => {
		const { result } = await runOf(
			apexTestRun({ codecoverage: [{ name: 'Marker', totalLines: 0, totalCovered: 0 }] }),
			{ minCoveragePercent: 85 },
		);

		const outcome = (result as { value: TestRunOutcome }).value;
		expect(outcome.status).toBe('passed');
		expect(outcome.belowMinimum).toEqual([]);
	});

	// Without a minimum the run reports where a team stands, and enforces
	// nothing, which is how the number gets chosen in the first place.
	test('reports without failing when none is given', async () => {
		const { result } = await runOf(
			apexTestRun({ codecoverage: [{ name: 'Greeter', totalLines: 10, totalCovered: 0 }] }),
		);

		const outcome = (result as { value: TestRunOutcome }).value;
		expect(outcome.status).toBe('passed');
		expect(outcome.tests.coverage[0]?.percent).toBe(0);
	});
});

describe('the configuration', () => {
	test('a commit without docket.yml cannot run tests', async () => {
		const fixture = await createGitFixture({ base: { 'README.md': 'x' }, head: { 'README.md': 'y' } });
		cleanups.push(fixture.remove);

		const result = await runTestRun({
			repositoryDirectory: fixture.directory,
			sha: fixture.headSha,
			outputDirectory: join(fixture.directory, 'out'),
			executable: 'sf',
			waitMinutes: 1,
			minCoveragePercent: null,
		});

		expect(result.ok).toBe(false);
	});
});
