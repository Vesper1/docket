import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for the Salesforce CLI.
 *
 * Fixtures must exercise the real code path — a spawned process, a JSON body
 * read off stdout, an exit code — without an org, so the fake is a real
 * executable rather than a stubbed function. What it cannot prove is that
 * Salesforce accepts the arguments; only M6 and M8 can.
 */
export interface FakeSf {
	/** Path to pass as `SalesforceCli.executable`. */
	readonly executable: string;
	/** The argument lists the fake was called with, in order. */
	invocations(): Promise<readonly string[][]>;
	remove(): Promise<void>;
}

/** One canned answer, chosen by the arguments Docket passes. */
export interface FakeResponse {
	/** Every token here must appear in the invocation for this answer to apply. */
	readonly when: readonly string[];
	readonly stdout: string;
	readonly exitCode?: number;
}

export interface FakeSfBehaviour {
	/** A single answer to every invocation. */
	readonly stdout?: string;
	readonly exitCode?: number;
	readonly stderr?: string;
	/** Answers chosen per subcommand, for a run that calls the CLI twice. */
	readonly responses?: readonly FakeResponse[];
	/** Makes the fake hang, so a timeout can be exercised. */
	readonly hang?: boolean;
}

export const createFakeSf = async (behaviour: FakeSfBehaviour): Promise<FakeSf> => {
	const directory = await mkdtemp(join(tmpdir(), 'docket-sf-'));
	const executable = join(directory, 'sf');
	const log = join(directory, 'invocations.log');

	const responses: readonly FakeResponse[] = behaviour.responses ?? [
		{ when: [], stdout: behaviour.stdout ?? '', ...(behaviour.exitCode === undefined ? {} : { exitCode: behaviour.exitCode }) },
	];

	// Node rather than a shell script: the arguments then survive newlines and
	// quotes exactly as Docket passed them, which is what the log is for.
	const script = [
		'#!/usr/bin/env node',
		`const { appendFileSync } = require('node:fs');`,
		'const argv = process.argv.slice(2);',
		`appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');`,
		behaviour.stderr === undefined ? '' : `process.stderr.write(${JSON.stringify(behaviour.stderr)});`,
		behaviour.hang === true ? 'setInterval(() => {}, 1000);' : '',
		behaviour.hang === true ? '' : `const responses = ${JSON.stringify(responses)};`,
		behaviour.hang === true
			? ''
			: 'const found = responses.find((response) => response.when.every((token) => argv.includes(token)));',
		behaviour.hang === true
			? ''
			: `if (found === undefined) {
	process.stdout.write(JSON.stringify({ status: 1, name: 'UnexpectedCommand', message: argv.join(' ') }));
	process.exit(1);
}`,
		behaviour.hang === true ? '' : 'process.stdout.write(found.stdout);',
		behaviour.hang === true ? '' : 'process.exit(found.exitCode ?? 0);',
	].join('\n');

	await writeFile(executable, `${script}\n`, 'utf8');
	await chmod(executable, 0o755);

	return {
		executable,
		invocations: async () => {
			const contents = await readFile(log, 'utf8').catch(() => '');
			return contents
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => JSON.parse(line) as string[]);
		},
		remove: () => rm(directory, { recursive: true, force: true }),
	};
}

/** A connected org, shaped like `sf org display --json`. */
export const orgDisplay = (id = '00D000000000001EAA'): string => {
	return JSON.stringify({
		status: 0,
		result: {
			id,
			username: 'qa@docket.invalid',
			instanceUrl: 'https://docket-qa.my.salesforce.com',
			connectedStatus: 'Connected',
		},
	});
};

/** A successful validation or deployment, shaped like the CLI's own output. */
export const successfulDeployment = (overrides: Record<string, unknown> = {}): string => {
	return JSON.stringify({
		status: 0,
		result: {
			id: '0Af000000000001CAA',
			status: 'Succeeded',
			success: true,
			checkOnly: true,
			numberComponentsDeployed: 1,
			details: {
				componentSuccesses: [{ componentType: 'ApexClass', fullName: 'Foo' }],
				runTestResult: { numTestsRun: 2, numFailures: 0, failures: [] },
			},
			...overrides,
		},
	});
};

/** A deployment Salesforce rejected: one component and one test failed. */
export const failedDeployment = (): string => {
	return JSON.stringify({
		status: 1,
		name: 'DeployFailed',
		message: 'Deploy failed.',
		result: {
			id: '0Af000000000002CAA',
			status: 'Failed',
			success: false,
			checkOnly: true,
			details: {
				componentFailures: {
					componentType: 'ApexClass',
					fullName: 'Foo',
					problem: 'Variable does not exist: bar',
				},
				runTestResult: {
					numTestsRun: 2,
					numFailures: 1,
					failures: {
						name: 'FooTest',
						methodName: 'testBar',
						message: 'System.AssertException: Assertion Failed',
					},
				},
			},
		},
	});
};

/** A full Apex test run, shaped like `sf apex run test --json`. */
export const apexTestRun = (overrides: {
	readonly summary?: Record<string, unknown>;
	readonly tests?: readonly unknown[];
	readonly codecoverage?: readonly unknown[];
} = {}): string => {
	return JSON.stringify({
		status: 0,
		result: {
			summary: {
				testRunId: '707000000000001AAA',
				outcome: 'Passed',
				testsRan: 2,
				passing: 2,
				failing: 0,
				skipped: 0,
				orgWideCoverage: '84%',
				...overrides.summary,
			},
			tests: overrides.tests ?? [
				{ ApexClass: { Name: 'GreeterTest' }, MethodName: 'greets', Outcome: 'Pass' },
			],
			codecoverage: overrides.codecoverage ?? [
				{ name: 'Greeter', totalLines: 10, totalCovered: 9 },
			],
		},
	});
};
