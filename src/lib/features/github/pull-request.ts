import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { parseCommitSha } from '../git/commit-sha.ts';
import { githubRequest } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';

/** What Docket needs to know about a pull request, and nothing more. */
export interface PullRequestFacts {
	readonly repository: string;
	readonly number: number;
	readonly state: string;
	readonly draft: boolean;
	readonly merged: boolean;
	/** The branch the pull request targets. */
	readonly baseBranch: string;
	/** Full SHA of the base branch tip GitHub reports for this pull request. */
	readonly baseSha: string;
	/** Full SHA of the pull request head. */
	readonly headSha: string;
	/** `owner/name` of the repository the head branch lives in. */
	readonly headRepository: string;
	/** The commit produced by merging, once merged. */
	readonly mergeCommitSha: string | null;
}

/**
 * Reads one pull request, freshly, at the moment it is needed.
 *
 * §5 Phase A.2 says "freshly": a webhook payload or a workflow event is a
 * snapshot from when the event fired, and the head can have moved since. Every
 * decision downstream is made about the SHAs read here.
 */
export async function readPullRequest(
	client: GitHubClient,
	repository: string,
	number: number,
): Promise<Result<PullRequestFacts, DocketError>> {
	const response = await githubRequest(client, {
		method: 'GET',
		path: `/repos/${repository}/pulls/${number}`,
	});
	if (!response.ok) return response;

	const body = asRecord(response.value.body);
	if (body === undefined) {
		return err(docketError(ErrorCode.githubFailed, `pull request ${number} came back unreadable`));
	}

	const base = asRecord(body['base']);
	const head = asRecord(body['head']);
	const baseSha = parseCommitSha(base?.['sha'], `pull request ${number} base SHA`, ErrorCode.githubFailed);
	const headSha = parseCommitSha(head?.['sha'], `pull request ${number} head SHA`, ErrorCode.githubFailed);
	const baseBranch = text(base?.['ref']);

	if (!baseSha.ok || !headSha.ok || baseBranch === undefined) {
		return err(
			docketError(ErrorCode.githubFailed, `pull request ${number} has no base or head to read`),
		);
	}
	let mergeCommitSha: string | null = null;
	if (body['merge_commit_sha'] !== null && body['merge_commit_sha'] !== undefined) {
		const parsed = parseCommitSha(
			body['merge_commit_sha'],
			`pull request ${number} merge commit SHA`,
			ErrorCode.githubFailed,
		);
		if (!parsed.ok) return parsed;
		mergeCommitSha = parsed.value;
	}

	return ok({
		repository,
		number,
		state: text(body['state']) ?? 'unknown',
		draft: body['draft'] === true,
		merged: body['merged'] === true,
		baseBranch,
		baseSha: baseSha.value,
		headSha: headSha.value,
		headRepository: text(asRecord(head?.['repo'])?.['full_name']) ?? '',
		mergeCommitSha,
	});
}

/**
 * The pull request must be one Docket is willing to validate.
 *
 * A fork's head lives in a repository the target org's credentials do not
 * belong to; a draft is not a request for anything yet; a closed one has no
 * merge to gate. Each is refused by name, so the answer says what to fix.
 */
export function requireValidatablePullRequest(
	pullRequest: PullRequestFacts,
): Result<PullRequestFacts, DocketError> {
	if (pullRequest.headRepository !== pullRequest.repository) {
		return err(
			ineligible(
				pullRequest,
				`its head is in ${pullRequest.headRepository || 'another repository'}, and only same-repository pull requests are supported`,
			),
		);
	}

	if (pullRequest.draft) return err(ineligible(pullRequest, 'it is a draft'));
	if (pullRequest.state !== 'open') {
		return err(ineligible(pullRequest, `it is ${pullRequest.state}`));
	}

	return ok(pullRequest);
}

/**
 * A deployment may only follow a merge.
 *
 * §5 Phase D.3: the deployment workflow is started by the merged-PR event, so
 * a pull request that was closed without merging must produce no deployment.
 */
export function requireMergedPullRequest(
	pullRequest: PullRequestFacts,
): Result<PullRequestFacts, DocketError> {
	if (pullRequest.headRepository !== pullRequest.repository) {
		return err(ineligible(pullRequest, 'its head is in another repository'));
	}

	if (!pullRequest.merged) {
		return err(ineligible(pullRequest, `it is ${pullRequest.state} and was not merged`));
	}

	if (pullRequest.mergeCommitSha === null) {
		return err(ineligible(pullRequest, 'GitHub reports no merge commit for it'));
	}

	return ok(pullRequest);
}

function ineligible(pullRequest: PullRequestFacts, reason: string): DocketError {
	return docketError(
		ErrorCode.pullRequestNotEligible,
		`pull request #${pullRequest.number} cannot be used: ${reason}`,
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}
