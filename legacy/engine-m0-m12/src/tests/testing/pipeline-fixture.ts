import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach } from 'vitest';

import type { CliContext } from '../../lib/features/cli/cli.ts';
import { createGitFixture } from '../../lib/features/git/testing/git-fixture.ts';
import type { GitFixture, TreeSnapshot } from '../../lib/features/git/testing/git-fixture.ts';
import type { FakeGitHub } from '../../lib/features/github/testing/fake-github.ts';
import {
	createFakeSf,
	orgDisplay,
	successfulDeployment,
} from '../../lib/features/salesforce/testing/fake-sf.ts';
import type { FakeSf, FakeSfBehaviour } from '../../lib/features/salesforce/testing/fake-sf.ts';

export const CLASSES = 'force-app/main/default/classes';

export const CONFIG = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests:
      mode: all
`;

export const PROJECT = JSON.stringify({
	packageDirectories: [{ path: 'force-app', default: true }],
	sourceApiVersion: '62.0',
});

/** The CLI answers `org display` and the two deploy verbs differently. */
export const VALIDATION_ID = '0Af000000000001CAA';
export const DEPLOYMENT_ID = '0Af000000000009CAA';

export const RESPONSES: FakeSfBehaviour = {
	responses: [
		{ when: ['org', 'display'], stdout: orgDisplay() },
		{ when: ['deploy', 'validate'], stdout: successfulDeployment() },
		{
			when: ['deploy', 'start'],
			stdout: successfulDeployment({ id: DEPLOYMENT_ID, checkOnly: false }),
		},
	],
};

export interface PipelineFixture {
	readonly context: CliContext;
	/** The repository and the exact commits, with no environment named yet. */
	readonly source: readonly string[];
	/** What `gates` takes: the change, plus the environment. No credentials. */
	readonly candidate: readonly string[];
	/** What `plan` takes: the candidate flags, plus the Salesforce CLI. */
	readonly planning: readonly string[];
	/** What `validate` takes: planning, plus how long to wait for Salesforce. */
	readonly validation: readonly string[];
	/** What `deploy` takes: it reads its plan back from artifacts, not from refs. */
	readonly deployment: readonly string[];
	readonly repository: GitFixture;
	readonly executable: string;
	readonly gates: string;
	readonly validated: string;
	readonly steps: string;
	readonly deployed: string;
	/** The subcommand words of every call the fake Salesforce CLI received. */
	calls(): Promise<string[]>;
	/** Every argument of every call, for assertions about one exact flag. */
	invocations(): Promise<readonly (readonly string[])[]>;
	/** Repoints the alias at another org mid-test, as a real re-auth would. */
	useSalesforce(behaviour: FakeSfBehaviour): Promise<string>;
	remove(): Promise<void>;
}

export interface TreeOptions {
	readonly base: TreeSnapshot;
	readonly head: TreeSnapshot;
	readonly behaviour?: FakeSfBehaviour;
	readonly targetBranch?: string;
	readonly prefix?: string;
}

/**
 * One deployment pipeline, end to end, with nothing real behind it: a real Git
 * repository, a fake Salesforce CLI on the PATH, and — where a test asks for
 * one — a fake GitHub. Every command is handed only the flags it declares.
 */
export const createTreeFixture = async (options: TreeOptions): Promise<PipelineFixture> => {
	const repository = await createGitFixture({ base: options.base, head: options.head });
	let sf: FakeSf = await createFakeSf(options.behaviour ?? RESPONSES);
	const workDirectory = await mkdtemp(join(tmpdir(), `${options.prefix ?? 'docket-pipeline'}-`));

	const context: CliContext = {
		version: '9.9.9',
		cwd: workDirectory,
		env: {},
		now: () => new Date('2026-08-16T10:00:00.000Z'),
	};

	const source = [
		'--repo',
		repository.directory,
		'--repository',
		'acme/salesforce',
		'--pull-request',
		'42',
		'--base',
		repository.baseSha,
		'--head',
		repository.headSha,
	];
	const candidate = [
		...source,
		...(options.targetBranch === undefined ? [] : ['--target-branch', options.targetBranch]),
		'--environment',
		'qa',
	];

	return {
		context,
		source,
		candidate,
		get planning() {
			return [...candidate, '--sf', sf.executable];
		},
		get validation() {
			return [...candidate, '--sf', sf.executable, '--wait', '1'];
		},
		get deployment() {
			return ['--repo', repository.directory, '--sf', sf.executable, '--wait', '1'];
		},
		repository,
		get executable() {
			return sf.executable;
		},
		gates: join(workDirectory, 'gates'),
		validated: join(workDirectory, 'validated'),
		steps: join(workDirectory, 'steps'),
		deployed: join(workDirectory, 'deployed'),
		async calls() {
			return (await sf.invocations()).map((argv) => argv.slice(0, 3).join(' '));
		},
		async invocations() {
			return sf.invocations();
		},
		async useSalesforce(behaviour) {
			await sf.remove();
			sf = await createFakeSf(behaviour);
			return sf.executable;
		},
		async remove() {
			await repository.remove();
			await sf.remove();
			await rm(workDirectory, { recursive: true, force: true });
		},
	};
};

export interface PipelineFixtureOptions {
	readonly behaviour?: FakeSfBehaviour;
	readonly config?: string;
	/** Head deletes the class instead of adding one, for the destructive paths. */
	readonly deletion?: boolean;
	readonly targetBranch?: string;
}

/** The ordinary repository these tests are about: one class added on a branch. */
export const createPipelineFixture = async (
	options: PipelineFixtureOptions = {},
): Promise<PipelineFixture> => {
	const config = options.config ?? CONFIG;
	const base = {
		'docket.yml': config,
		'sfdx-project.json': PROJECT,
		[`${CLASSES}/Foo.cls`]: 'public class Foo {}',
	};
	const head =
		options.deletion === true
			? { 'docket.yml': config, 'sfdx-project.json': PROJECT }
			: { ...base, [`${CLASSES}/Bar.cls`]: 'public class Bar {}' };

	return createTreeFixture({
		base,
		head,
		...(options.behaviour === undefined ? {} : { behaviour: options.behaviour }),
		...(options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch }),
	});
};

/**
 * Hands a test file a fixture factory and takes the cleanup off its hands: a
 * suite that opens three repositories still leaves nothing behind.
 */
export const pipelineFixtures = (): {
	setUp: (options?: PipelineFixtureOptions) => Promise<PipelineFixture>;
	setUpTree: (options: TreeOptions) => Promise<PipelineFixture>;
} => {
	const open: PipelineFixture[] = [];

	afterEach(async () => {
		for (const fixture of open.splice(0)) await fixture.remove();
	});

	return {
		setUp: async (options = {}) => track(open, await createPipelineFixture(options)),
		setUpTree: async (options) => track(open, await createTreeFixture(options)),
	};
}

/** Points a run at the fake GitHub instead of the real API. */
export const githubContext = (github: FakeGitHub) => {
	return { fetch: github.fetch, githubBaseUrl: github.baseUrl };
};

const track = (open: PipelineFixture[], fixture: PipelineFixture): PipelineFixture => {
	open.push(fixture);
	return fixture;
};
