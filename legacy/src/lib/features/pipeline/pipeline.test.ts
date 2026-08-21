import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { createGitFixture } from '../git/testing/git-fixture.ts';
import type { GitFixture, TreeSnapshot } from '../git/testing/git-fixture.ts';
import { createFakeSf } from '../salesforce/testing/fake-sf.ts';
import type { FakeSf } from '../salesforce/testing/fake-sf.ts';
import { runPipeline } from './run-pipeline.ts';

/**
 * The whole POC in one place: a real repository, a real spawned CLI, real
 * artifacts on disk. What it cannot prove is that Salesforce accepts the
 * arguments — only a live org can.
 */
const CONFIG = [
	'version: 1',
	'org: docket-qa',
	'tests: all',
	'allowDestructiveChanges: true',
	'gates:',
	'  - name: unit',
	'    run: exit 0',
	'',
].join('\n');

const CLASS_PATH = 'force-app/main/default/classes/Greeter.cls';
const META_PATH = `${CLASS_PATH}-meta.xml`;
const META = '<?xml version="1.0" encoding="UTF-8"?><ApexClass/>';

const DEPLOY_SUCCESS = JSON.stringify({
	status: 0,
	result: {
		id: '0Af000000000001AAA',
		status: 'Succeeded',
		success: true,
		checkOnly: false,
		details: {},
	},
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixtureOf = async (base: TreeSnapshot, head: TreeSnapshot): Promise<GitFixture> => {
	const fixture = await createGitFixture({
		base: { 'docket.yml': CONFIG, ...base },
		head: { 'docket.yml': CONFIG, ...head },
	});
	cleanups.push(fixture.remove);
	return fixture;
};

const sfOf = async (stdout: string, exitCode = 0): Promise<FakeSf> => {
	const sf = await createFakeSf({ stdout, exitCode });
	cleanups.push(sf.remove);
	return sf;
};

const outputDirectory = async (): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), 'docket-out-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return directory;
};

describe('deploy', () => {
	test('deploys one added Apex class and records what it did', async () => {
		const fixture = await fixtureOf({}, { [CLASS_PATH]: 'public class Greeter {}', [META_PATH]: META });
		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'deploy',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(true);
		if (!run.ok) return;

		expect(run.value.status).toBe('passed');
		expect(run.value.plan.sourceSha).toBe(fixture.headSha);
		expect(run.value.deployment?.deploymentId).toBe('0Af000000000001AAA');

		const manifest = await readFile(join(out, 'package.xml'), 'utf8');
		expect(manifest).toContain('<members>Greeter</members>');
		expect(manifest).toContain('<name>ApexClass</name>');

		// A pure addition deletes nothing, so no destructive manifest is written.
		await expect(readFile(join(out, 'destructiveChanges.xml'), 'utf8')).rejects.toThrow();

		const [invocation] = await sf.invocations();
		expect(invocation).toContain('start');
		expect(invocation).toContain('RunLocalTests');
	});

	test('a deleted class becomes a destructive manifest', async () => {
		const fixture = await fixtureOf({ [CLASS_PATH]: 'public class Greeter {}', [META_PATH]: META }, {});
		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'deploy',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(true);
		if (!run.ok) return;

		expect(run.value.plan.components.destructive.map((c) => c.member)).toEqual(['Greeter']);
		expect(await readFile(join(out, 'destructiveChanges.xml'), 'utf8')).toContain(
			'<members>Greeter</members>',
		);

		const [invocation] = await sf.invocations();
		expect(invocation).toContain('--pre-destructive-changes');
	});

	test('a failing gate stops the run before Salesforce is asked anything', async () => {
		const failing = CONFIG.replace('run: exit 0', 'run: exit 3');
		const fixture = await createGitFixture({
			base: { 'docket.yml': failing },
			head: { 'docket.yml': failing, [CLASS_PATH]: 'public class Greeter {}', [META_PATH]: META },
		});
		cleanups.push(fixture.remove);

		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'deploy',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(true);
		if (!run.ok) return;

		expect(run.value.status).toBe('failed');
		expect(run.value.failures).toEqual(['gate `unit` failed']);
		expect(run.value.deployment).toBeNull();
		expect(await sf.invocations()).toEqual([]);
	});

	test('a deletion is refused when the policy forbids it', async () => {
		const strict = CONFIG.replace('allowDestructiveChanges: true', 'allowDestructiveChanges: false');
		const fixture = await createGitFixture({
			base: { 'docket.yml': strict, [CLASS_PATH]: 'public class Greeter {}', [META_PATH]: META },
			head: { 'docket.yml': strict },
		});
		cleanups.push(fixture.remove);

		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'deploy',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(false);
		if (run.ok) return;

		expect(run.error.code).toBe('destructive_not_allowed');
		expect(await sf.invocations()).toEqual([]);
	});

	test('configuration is read from the base commit, not the candidate', async () => {
		// The head commit repoints the org. A run must ignore that entirely.
		const hijacked = CONFIG.replace('org: docket-qa', 'org: production');
		const fixture = await createGitFixture({
			base: { 'docket.yml': CONFIG },
			head: {
				'docket.yml': hijacked,
				[CLASS_PATH]: 'public class Greeter {}',
				[META_PATH]: META,
			},
		});
		cleanups.push(fixture.remove);

		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'deploy',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(true);
		if (!run.ok) return;

		expect(run.value.plan.org).toBe('docket-qa');
	});
});

describe('rollback', () => {
	test('inverts an addition into a deletion and deploys the base tree', async () => {
		const fixture = await fixtureOf({}, { [CLASS_PATH]: 'public class Greeter {}', [META_PATH]: META });
		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'rollback',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(true);
		if (!run.ok) return;

		// The class the deployment added is what the rollback deletes.
		expect(run.value.plan.components.destructive.map((c) => c.member)).toEqual(['Greeter']);
		expect(run.value.plan.components.deployable).toEqual([]);
		// Restored bytes come from the base commit, so that is the tree deployed.
		expect(run.value.plan.sourceSha).toBe(fixture.baseSha);
	});

	test('restores a class the deployment deleted', async () => {
		const fixture = await fixtureOf({ [CLASS_PATH]: 'public class Greeter {}', [META_PATH]: META }, {});
		const sf = await sfOf(DEPLOY_SUCCESS);
		const out = await outputDirectory();

		const run = await runPipeline({
			kind: 'rollback',
			repositoryDirectory: fixture.directory,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
			outputDirectory: out,
			executable: sf.executable,
			waitMinutes: 1,
			checkOnly: false,
		});

		expect(run.ok).toBe(true);
		if (!run.ok) return;

		expect(run.value.plan.components.deployable.map((c) => c.member)).toEqual(['Greeter']);
		expect(run.value.plan.components.destructive).toEqual([]);
		expect(await readFile(join(out, 'package.xml'), 'utf8')).toContain('<members>Greeter</members>');
	});
});
