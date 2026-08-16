import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { RollbackPlan, RollbackProposal } from '../rollback/rollback-plan.ts';
import { githubRequest } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';

const SHA = /^[0-9a-f]{40}$/;

export interface CompensatingPullRequest {
	readonly number: number;
	readonly url: string;
	readonly repository: string;
	readonly branch: string;
	readonly baseBranch: string;
	readonly baseSha: string;
	readonly commitSha: string;
	readonly rollbackIdentity: string;
}

/** Freshly resolves the configured target branch before rollback calculation. */
export async function readBranchHead(
	client: GitHubClient,
	repository: string,
	branch: string,
): Promise<Result<string, DocketError>> {
	if (!repositoryName(repository)) {
		return err(docketError(ErrorCode.rollbackSourceInvalid, 'rollback source has an invalid repository name'));
	}
	if (!branchName(branch)) {
		return err(docketError(ErrorCode.rollbackConflict, `cannot use target branch ${JSON.stringify(branch)}`));
	}

	const response = await githubRequest(client, {
		method: 'GET',
		path: `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
	});
	if (!response.ok) return response;

	const sha = text(asRecord(asRecord(response.value.body)?.['object'])?.['sha']);
	return sha !== undefined && SHA.test(sha)
		? ok(sha)
		: err(docketError(ErrorCode.githubFailed, `GitHub returned no commit for branch \`${branch}\``));
}

/**
 * M11.6: writes one Git tree, one commit, one new branch and one PR. It never
 * updates the target branch and it never calls Salesforce.
 */
export async function createCompensatingPullRequest(
	client: GitHubClient,
	proposal: RollbackProposal,
): Promise<Result<CompensatingPullRequest, DocketError>> {
	const { plan } = proposal;
	if (!plan.normalFlow.ready) {
		return err(
			docketError(
				ErrorCode.destructiveNotAllowed,
				`cannot create rollback PR: environment ${plan.target.environmentId} forbids the inverse deletion`,
			),
		);
	}

	// A branch may have advanced while the local Git calculation ran. Re-read
	// immediately before the first mutation and refuse a stale proposal.
	const current = await readBranchHead(client, plan.source.repository, plan.target.branch);
	if (!current.ok) return current;
	if (current.value !== plan.target.baseSha) {
		return err(
			docketError(
				ErrorCode.rollbackConflict,
				`cannot create rollback PR: branch \`${plan.target.branch}\` moved from ${plan.target.baseSha} to ${current.value}`,
			),
		);
	}

	const baseTree = await treeOfCommit(client, plan.source.repository, plan.target.baseSha);
	if (!baseTree.ok) return baseTree;

	const tree = await githubRequest(client, {
		method: 'POST',
		path: `/repos/${plan.source.repository}/git/trees`,
		body: {
			base_tree: baseTree.value,
			tree: proposal.files.map((operation) =>
				operation.kind === 'delete'
					? { path: operation.path, mode: '100644', type: 'blob', sha: null }
					: {
							path: operation.path,
							mode: operation.mode,
							type: 'blob',
							content: operation.contents,
						},
			),
		},
	});
	if (!tree.ok) return tree;
	const treeSha = responseSha(tree.value.body, 'tree');
	if (!treeSha.ok) return treeSha;

	const commit = await githubRequest(client, {
		method: 'POST',
		path: `/repos/${plan.source.repository}/git/commits`,
		body: {
			message: plan.title,
			tree: treeSha.value,
			parents: [plan.target.baseSha],
		},
	});
	if (!commit.ok) return commit;
	const commitSha = responseSha(commit.value.body, 'commit');
	if (!commitSha.ok) return commitSha;

	const reference = await githubRequest(client, {
		method: 'POST',
		path: `/repos/${plan.source.repository}/git/refs`,
		body: { ref: `refs/heads/${plan.branch}`, sha: commitSha.value },
	});
	if (!reference.ok) return reference;
	const referenceRecord = asRecord(reference.value.body);
	const referenceName = text(referenceRecord?.['ref']);
	const referenceSha = text(asRecord(referenceRecord?.['object'])?.['sha']);
	if (referenceName !== `refs/heads/${plan.branch}` || referenceSha !== commitSha.value) {
		return err(docketError(ErrorCode.githubFailed, 'GitHub created no matching rollback branch'));
	}

	const pull = await githubRequest(client, {
		method: 'POST',
		path: `/repos/${plan.source.repository}/pulls`,
		body: {
			title: plan.title,
			head: plan.branch,
			base: plan.target.branch,
			body: plan.body,
		},
	});
	if (!pull.ok) return pull;

	return parsePullRequest(pull.value.body, plan, commitSha.value);
}

async function treeOfCommit(
	client: GitHubClient,
	repository: string,
	sha: string,
): Promise<Result<string, DocketError>> {
	const response = await githubRequest(client, {
		method: 'GET',
		path: `/repos/${repository}/git/commits/${sha}`,
	});
	if (!response.ok) return response;

	const tree = asRecord(asRecord(response.value.body)?.['tree']);
	const treeSha = text(tree?.['sha']);
	return treeSha !== undefined && SHA.test(treeSha)
		? ok(treeSha)
		: err(docketError(ErrorCode.githubFailed, `GitHub returned no tree for commit ${sha}`));
}

function responseSha(body: unknown, kind: string): Result<string, DocketError> {
	const sha = text(asRecord(body)?.['sha']);
	return sha !== undefined && SHA.test(sha)
		? ok(sha)
		: err(docketError(ErrorCode.githubFailed, `GitHub returned no ${kind} SHA`));
}

function parsePullRequest(
	body: unknown,
	plan: RollbackPlan,
	commitSha: string,
): Result<CompensatingPullRequest, DocketError> {
	const record = asRecord(body);
	const number = record?.['number'];
	const url = text(record?.['html_url']);
	const state = text(record?.['state']);
	const head = asRecord(record?.['head']);
	const base = asRecord(record?.['base']);
	const headRepository = text(asRecord(head?.['repo'])?.['full_name']);
	if (
		typeof number !== 'number' ||
		!Number.isInteger(number) ||
		number <= 0 ||
		url === undefined ||
		state !== 'open' ||
		text(head?.['ref']) !== plan.branch ||
		text(head?.['sha']) !== commitSha ||
		headRepository !== plan.source.repository ||
		text(base?.['ref']) !== plan.target.branch
	) {
		return err(docketError(ErrorCode.githubFailed, 'GitHub created no readable pull request'));
	}

	return ok({
		number,
		url,
		repository: plan.source.repository,
		branch: plan.branch,
		baseBranch: plan.target.branch,
		baseSha: plan.target.baseSha,
		commitSha,
		rollbackIdentity: plan.identity,
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function repositoryName(value: string): boolean {
	return /^[^/\s]+\/[^/\s]+$/.test(value);
}

/** Git check-ref-format rules narrowed to branch names Docket can safely address. */
function branchName(value: string): boolean {
	return (
		value !== '' &&
		!value.startsWith('-') &&
		!value.startsWith('/') &&
		!value.endsWith('/') &&
		!value.endsWith('.') &&
		!value.endsWith('.lock') &&
		!value.includes('..') &&
		!value.includes('@{') &&
		!value.includes('//') &&
		!/[\u0000-\u0020~^:?*\[\\]/.test(value)
	);
}
