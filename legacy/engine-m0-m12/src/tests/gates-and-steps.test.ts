import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runCli } from '../lib/features/cli/cli.ts';
import { ExitCode } from '../lib/features/cli/exit-code.ts';
import { createFakeGitHub } from '../lib/features/github/testing/fake-github.ts';
import { CLASSES, githubContext, pipelineFixtures, PROJECT } from './testing/pipeline-fixture.ts';
import type { PipelineFixture } from './testing/pipeline-fixture.ts';

const { setUpTree } = pipelineFixtures();

describe('M10 gates and deployment steps end to end', () => {
	function config(pre = 'bash scripts/pre.sh', post = 'bash scripts/post.sh', gate = 'exit 0') {
		return `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: lint
        run: ${gate}
    preDeployment:
      - name: prepare
        run: ${pre}
      - name: release-window
        manual: true
        instructions: Confirm the release window
    postDeployment:
      - name: smoke
        run: ${post}
`;
	}

	/**
	 * Head changes both hook scripts to fail. A run that passes proves the
	 * privileged bytes came from the trusted base workspace instead.
	 */
	async function m10Setup(
		configuration: string,
		headScripts = { pre: 'exit 91', post: 'exit 92' },
	): Promise<PipelineFixture> {
		const base = {
			'docket.yml': configuration,
			'sfdx-project.json': PROJECT,
			[`${CLASSES}/Foo.cls`]: 'public class Foo {}',
			'scripts/pre.sh': 'exit 0',
			'scripts/post.sh': 'exit 0',
		};

		return setUpTree({
			base,
			head: {
				...base,
				[`${CLASSES}/Bar.cls`]: 'public class Bar {}',
				'scripts/pre.sh': headScripts.pre,
				'scripts/post.sh': headScripts.post,
			},
			targetBranch: 'main',
			prefix: 'docket-m10',
		});
	}

	test('a failed credential-free gate cannot start Salesforce validation', async () => {
		const setup = await m10Setup(config('exit 0', 'exit 0', 'exit 12'));
		const gate = await runCli(['gates', ...setup.candidate, '--out', setup.gates, '--json'], setup.context);
		expect(gate.exitCode).toBe(ExitCode.failure);

		const validation = await runCli(
			['validate', ...setup.validation, '--gates-run', setup.gates, '--out', setup.validated, '--json'],
			setup.context,
		);
		expect(JSON.parse(validation.stdout).error.code).toBe('validation_not_passed');
		expect(await setup.calls()).not.toContain('project deploy validate');
	});

	test('manual completion unlocks trusted base hooks and records the post hook', async () => {
		const setup = await m10Setup(config());
		expect(
			(await runCli(['gates', ...setup.candidate, '--out', setup.gates, '--json'], setup.context)).exitCode,
		).toBe(ExitCode.success);

		const validation = await runCli(
			['validate', ...setup.validation, '--gates-run', setup.gates, '--out', setup.validated, '--json'],
			setup.context,
		);
		const validationRun = JSON.parse(validation.stdout).data.run;
		expect(validationRun.steps.map((step: { name: string }) => step.name)).toEqual([
			'lint',
			'release-window',
		]);
		expect(validationRun.steps[1].status).toBe('pending');

		const blocked = await runCli(
			[
				'deploy', ...setup.deployment,
				'--validated-run', setup.validated,
				'--out', setup.deployed,
				'--json',
			],
			setup.context,
		);
		expect(JSON.parse(blocked.stdout).error.code).toBe('step_incomplete');

		const completed = await runCli(
			[
				'complete-step',
				'--validated-run', setup.validated,
				'--step', 'release-window',
				'--by', 'taras',
				'--steps', setup.steps,
				'--json',
			],
			setup.context,
		);
		expect(completed.exitCode).toBe(ExitCode.success);

		const deployment = await runCli(
			[
				'deploy', ...setup.deployment,
				'--validated-run', setup.validated,
				'--steps', setup.steps,
				'--out', setup.deployed,
				'--json',
			],
			setup.context,
		);
		expect(deployment.exitCode).toBe(ExitCode.success);
		const run = JSON.parse(await readFile(join(setup.deployed, 'run.json'), 'utf8'));
		expect(run.steps).toEqual([
			{ name: 'prepare', kind: 'pre', manual: false, status: 'passed', exitCode: 0, completedBy: null },
			{ name: 'release-window', kind: 'pre', manual: true, status: 'passed', exitCode: null, completedBy: 'taras' },
			{ name: 'smoke', kind: 'post', manual: false, status: 'passed', exitCode: 0, completedBy: null },
		]);
		expect(run.status).toBe('passed');
	});

	test('missing publication provenance creates no completion record', async () => {
		const setup = await m10Setup(config());
		await runCli(['gates', ...setup.candidate, '--out', setup.gates], setup.context);
		await runCli(
			['validate', ...setup.validation, '--gates-run', setup.gates, '--out', setup.validated],
			setup.context,
		);

		const outcome = await runCli(
			[
				'complete-step',
				'--repository', 'acme/salesforce',
				'--validated-run', setup.validated,
				'--step', 'release-window',
				'--by', 'taras',
				'--steps', setup.steps,
				'--json',
			],
			setup.context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('missing_option');
		expect(await readdir(setup.steps).catch(() => [])).toEqual([]);
	});

	test('the publish phase reuses the immutable completion recorded before upload', async () => {
		const setup = await m10Setup(config());
		await runCli(['gates', ...setup.candidate, '--out', setup.gates], setup.context);
		await runCli(
			['validate', ...setup.validation, '--gates-run', setup.gates, '--out', setup.validated],
			setup.context,
		);
		const plan = JSON.parse(await readFile(join(setup.validated, 'plan.json'), 'utf8'));
		const externalId = JSON.stringify({
			v: 1,
			s: 'release-window',
			p: plan.identity,
			vr: '123456',
			cr: null,
		});
		const github = createFakeGitHub({
			[`GET /repos/acme/salesforce/commits/${plan.source.headSha}/check-runs`]: {
				status: 200,
				body: { check_runs: [{ id: 12, external_id: externalId }] },
			},
			'PATCH /repos/acme/salesforce/check-runs/12': { status: 200, body: { id: 12 } },
		});
		const completion = [
			'complete-step',
			'--validated-run', setup.validated,
			'--step', 'release-window',
			'--by', 'taras',
			'--workflow-run-id', '777',
			'--steps', setup.steps,
		];

		const recorded = await runCli(completion, setup.context);
		const published = await runCli([...completion, '--repository', 'acme/salesforce', '--json'], {
			...setup.context,
			env: { GITHUB_TOKEN: 'a-scoped-token' },
			...githubContext(github),
		});

		expect(recorded.exitCode).toBe(ExitCode.success);
		expect(published.exitCode).toBe(ExitCode.success);
		expect(await readdir(setup.steps)).toHaveLength(1);
		expect(github.requests().at(-1)?.method).toBe('PATCH');
	});

	test('a failing trusted pre-hook records its exit and stops before deploy', async () => {
		const setup = await m10Setup(config('exit 23', 'exit 0'), { pre: 'exit 0', post: 'exit 0' });
		await runCli(['gates', ...setup.candidate, '--out', setup.gates], setup.context);
		await runCli(
			['validate', ...setup.validation, '--gates-run', setup.gates, '--out', setup.validated],
			setup.context,
		);
		await runCli(
			[
				'complete-step',
				'--validated-run', setup.validated,
				'--step', 'release-window',
				'--by', 'taras',
				'--steps', setup.steps,
			],
			setup.context,
		);

		const deployment = await runCli(
			[
				'deploy', ...setup.deployment,
				'--validated-run', setup.validated,
				'--steps', setup.steps,
				'--out', setup.deployed,
				'--json',
			],
			setup.context,
		);
		expect(deployment.exitCode).toBe(ExitCode.failure);
		const run = JSON.parse(deployment.stdout).data.run;
		expect(run.steps[0]).toMatchObject({ name: 'prepare', status: 'failed', exitCode: 23 });
		expect(run.deployment).toBeNull();
		expect(await setup.calls()).not.toContain('project deploy start');
	});
});
