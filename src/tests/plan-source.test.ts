import { describe, expect, test } from 'vitest';

import { runCli } from '../lib/features/cli/cli.ts';
import { ExitCode } from '../lib/features/cli/exit-code.ts';
import { createFakeGitHub, pullRequestBody } from '../lib/features/github/testing/fake-github.ts';
import { githubContext, pipelineFixtures } from './testing/pipeline-fixture.ts';

const { setUp } = pipelineFixtures();

const TOKEN = { GITHUB_TOKEN: 'a-scoped-token' };

describe('a plan built from a pull request', () => {
	test('a non-SHA ref is refused before Git is run', async () => {
		const { context, repository } = await setUp();

		const outcome = await runCli(
			[
				'changes',
				'--repo', repository.directory,
				'--base', 'not-a-commit-sha',
				'--head', repository.headSha,
				'--json',
			],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('invalid_option');
	});

	test('GitHub supplies the exact SHAs and the branch the plan is checked against', async () => {
		const { context, planning, repository, executable } = await setUp();
		const github = createFakeGitHub({
			'GET /repos/acme/salesforce/pulls/42': {
				status: 200,
				body: pullRequestBody({
					base: {
						ref: 'main',
						sha: repository.baseSha,
						repo: { full_name: 'acme/salesforce' },
					},
					head: {
						ref: 'feature',
						sha: repository.headSha,
						repo: { full_name: 'acme/salesforce' },
					},
				}),
			},
		});

		const fromGitHub = await runCli(
			[
				'plan',
				'--repo',
				repository.directory,
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--environment',
				'qa',
				'--sf',
				executable,
				'--json',
			],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		const local = await runCli(['plan', ...planning, '--json'], context);

		expect(fromGitHub.exitCode).toBe(ExitCode.success);
		expect(JSON.parse(fromGitHub.stdout).data.plan).toEqual(JSON.parse(local.stdout).data.plan);
	});

	test('a draft pull request is refused before any plan exists', async () => {
		const { context, repository } = await setUp();
		const github = createFakeGitHub({
			'GET /repos/acme/salesforce/pulls/42': {
				status: 200,
				body: pullRequestBody({ draft: true }),
			},
		});

		const outcome = await runCli(
			[
				'plan',
				'--repo',
				repository.directory,
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--environment',
				'qa',
				'--json',
			],
			{ ...context, env: TOKEN, ...githubContext(github) },
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('pull_request_not_eligible');
	});

	test('without a token and without explicit SHAs, nothing is guessed', async () => {
		const { context, repository } = await setUp();

		const outcome = await runCli(
			[
				'plan',
				'--repo',
				repository.directory,
				'--repository',
				'acme/salesforce',
				'--pull-request',
				'42',
				'--environment',
				'qa',
				'--json',
			],
			context,
		);

		expect(JSON.parse(outcome.stdout).error.code).toBe('missing_option');
	});
});
