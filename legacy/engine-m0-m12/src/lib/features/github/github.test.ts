import { describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import { isErr, isOk } from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import {
	readPullRequest,
	requireMergedPullRequest,
	requireValidatablePullRequest,
} from './pull-request.ts';
import { createFakeGitHub, pullRequestBody } from './testing/fake-github.ts';
import type { Routes } from './testing/fake-github.ts';

const PATH = '/repos/acme/salesforce/pulls/42';

const githubWith = (routes: Routes) => {
	const fake = createFakeGitHub(routes);
	return {
		fake,
		client: { token: 'a-scoped-token', baseUrl: fake.baseUrl, fetch: fake.fetch },
	};
};

const open = (overrides: Record<string, unknown> = {}) => {
	return githubWith({ [`GET ${PATH}`]: { status: 200, body: pullRequestBody(overrides) } });
};

describe('reading a pull request', () => {
	test('the exact base and head SHAs come from GitHub', async () => {
		const { client } = open();

		const pullRequest = await readPullRequest(client, 'acme/salesforce', 42);

		expect(pullRequest).toEqual({
			ok: true,
			value: {
				repository: 'acme/salesforce',
				number: 42,
				state: 'open',
				draft: false,
				merged: false,
				baseBranch: 'main',
				baseSha: 'a'.repeat(40),
				headSha: 'b'.repeat(40),
				headRepository: 'acme/salesforce',
				mergeCommitSha: null,
			},
		});
	});

	test('the request is authenticated and version-pinned', async () => {
		const { client, fake } = open();

		await readPullRequest(client, 'acme/salesforce', 42);

		expect(fake.requests()).toEqual([
			{ method: 'GET', path: PATH, body: undefined, authorization: 'Bearer a-scoped-token' },
		]);
	});

	test('a pull request that does not exist is a failure, not an empty plan', async () => {
		const { client } = githubWith({});

		const result = await readPullRequest(client, 'acme/salesforce', 42);

		expect(errorOf(result).code).toBe(ErrorCode.githubFailed);
		expect(errorOf(result).message).toContain('404');
	});

	test('a failure never echoes the token back', async () => {
		const { client } = githubWith({
			[`GET ${PATH}`]: { status: 401, body: { message: 'Bad credentials' } },
		});

		const result = await readPullRequest(client, 'acme/salesforce', 42);

		expect(errorOf(result).message).not.toContain('a-scoped-token');
	});
});

describe('which pull requests may be validated', () => {
	async function facts(overrides: Record<string, unknown>) {
		const { client } = open(overrides);
		const result = await readPullRequest(client, 'acme/salesforce', 42);
		if (!isOk(result)) throw new Error('expected a pull request');
		return result.value;
	}

	test('an open, non-draft, same-repository pull request is accepted', async () => {
		expect(isOk(requireValidatablePullRequest(await facts({})))).toBe(true);
	});

	test('a fork is refused by name', async () => {
		const fork = await facts({
			head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'someone/fork' } },
		});

		const result = requireValidatablePullRequest(fork);
		expect(errorOf(result).code).toBe(ErrorCode.pullRequestNotEligible);
		expect(errorOf(result).message).toContain('someone/fork');
	});

	test('a draft is refused by name', async () => {
		const result = requireValidatablePullRequest(await facts({ draft: true }));

		expect(errorOf(result).message).toContain('draft');
	});

	test('a closed pull request is refused by name', async () => {
		const result = requireValidatablePullRequest(await facts({ state: 'closed' }));

		expect(errorOf(result).message).toContain('closed');
	});
});

describe('which pull requests may be deployed', () => {
	async function facts(overrides: Record<string, unknown>) {
		const { client } = open(overrides);
		const result = await readPullRequest(client, 'acme/salesforce', 42);
		if (!isOk(result)) throw new Error('expected a pull request');
		return result.value;
	}

	test('a merged pull request carries its merge commit', async () => {
		const merged = await facts({
			state: 'closed',
			merged: true,
			merge_commit_sha: 'c'.repeat(40),
		});

		const result = requireMergedPullRequest(merged);
		expect(isOk(result) && result.value.mergeCommitSha).toBe('c'.repeat(40));
	});

	test('closing without merging deploys nothing', async () => {
		const closed = await facts({ state: 'closed', merged: false });

		const result = requireMergedPullRequest(closed);
		expect(errorOf(result).code).toBe(ErrorCode.pullRequestNotEligible);
		expect(errorOf(result).message).toContain('was not merged');
	});

	test('a merge GitHub reports no commit for is refused', async () => {
		const odd = await facts({ state: 'closed', merged: true, merge_commit_sha: null });

		expect(isErr(requireMergedPullRequest(odd))).toBe(true);
	});
});
