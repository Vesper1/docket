import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { parseConfig } from '../config/parse-config.ts';
import { createGitFixture } from '../git/testing/git-fixture.ts';
import type { GitFixture } from '../git/testing/git-fixture.ts';
import { isErr, isOk } from '../../shared/result/result.ts';
import { GATE_ARTIFACT_NAME, gateRun, readPassedGateRun } from './gate-run.ts';

const BASE_CONFIG = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: lint
        run: exit 0
`;

let fixture: GitFixture | undefined;
let output: string | undefined;

afterEach(async () => {
	await fixture?.remove();
	if (output !== undefined) await rm(output, { recursive: true, force: true });
	fixture = undefined;
	output = undefined;
});

async function setup(config = BASE_CONFIG) {
	fixture = await createGitFixture({
		base: { 'docket.yml': config },
		head: { 'docket.yml': config, 'README.md': 'candidate' },
	});
	output = await mkdtemp(join(tmpdir(), 'docket-gates-'));
	return {
		repositoryDirectory: fixture.directory,
		outputDirectory: output,
		source: {
			repository: 'acme/salesforce',
			pullRequest: 42,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
		},
		environmentId: 'qa',
		targetBranch: 'main',
	};
}

function environment(config = BASE_CONFIG) {
	const parsed = parseConfig(config);
	if (!isOk(parsed) || parsed.value.environments[0] === undefined) {
		throw new Error('expected a valid gate fixture');
	}
	return parsed.value.environments[0];
}

describe('the credential-free gate phase', () => {
	test('records a passing command and its log before validation', async () => {
		const request = await setup();
		const result = await gateRun(request);

		expect(isOk(result) && result.value.status).toBe('passed');
		expect(isOk(result) && result.value.results[0]?.name).toBe('lint');
		expect(await readFile(join(request.outputDirectory, 'logs/gate-lint.log'), 'utf8')).toContain(
			'exit 0',
		);
	});

	test('a failed gate cannot be presented to credentialed validation as a pass', async () => {
		const config = BASE_CONFIG.replace('exit 0', 'exit 17');
		const request = await setup(config);
		const run = await gateRun(request);
		expect(isOk(run) && run.value.status).toBe('failed');

		const read = await readPassedGateRun(request.outputDirectory, {
			source: request.source,
			environment: environment(config),
			targetBranch: 'main',
		});
		expect(isErr(read) && read.error.code).toBe('validation_not_passed');
	});

	test('editing the transferred verdict does not turn a failed result green', async () => {
		const config = BASE_CONFIG.replace('exit 0', 'exit 17');
		const request = await setup(config);
		await gateRun(request);

		const path = join(request.outputDirectory, GATE_ARTIFACT_NAME);
		const record = JSON.parse(await readFile(path, 'utf8'));
		record.status = 'passed';
		await writeFile(path, JSON.stringify(record), 'utf8');

		const read = await readPassedGateRun(request.outputDirectory, {
			source: request.source,
			environment: environment(config),
			targetBranch: 'main',
		});
		expect(isErr(read) && read.error.code).toBe('plan_mismatch');
	});

	test('a gate artifact for another head SHA is stale', async () => {
		const request = await setup();
		await gateRun(request);

		const read = await readPassedGateRun(request.outputDirectory, {
			source: { ...request.source, headSha: 'c'.repeat(40) },
			environment: environment(),
			targetBranch: 'main',
		});
		expect(isErr(read) && read.error.code).toBe('plan_mismatch');
	});
});
