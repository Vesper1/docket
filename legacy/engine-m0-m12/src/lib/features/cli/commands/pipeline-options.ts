import { isAbsolute, join } from 'node:path';

import { docketError, ErrorCode } from '../../../shared/result/docket-error.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { err, ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import type { GitHubClient } from '../../github/github-client.ts';
import { parseCommitSha } from '../../git/commit-sha.ts';
import {
	readPullRequest,
	requireMergedPullRequest,
	requireValidatablePullRequest,
} from '../../github/pull-request.ts';
import type { PullRequestFacts } from '../../github/pull-request.ts';
import type { PlanSource } from '../../plan/deployment-plan.ts';
import type { OrgIdResolver } from '../../pipeline/prepare.ts';
import type { RunExecutor, RunWorkflow } from '../../run/run-record.ts';
import { resolveOrg } from '../../salesforce/org.ts';
import { DEFAULT_SF_EXECUTABLE } from '../../salesforce/sf-cli.ts';
import { parseSalesforceOrgId } from '../../salesforce/org-id.ts';
import { requiredOption } from './option.ts';

/**
 * Each helper below asks for exactly the flags it reads, and nothing else.
 *
 * A command satisfies one of these by declaring those flags; a command that
 * does not declare them cannot call the helper, so the option table and the
 * code that reads it cannot drift apart.
 */
export interface SourceOptions {
	readonly repository?: string | undefined;
	readonly 'pull-request'?: string | undefined;
	readonly base?: string | undefined;
	readonly head?: string | undefined;
	readonly 'target-branch'?: string | undefined;
	readonly 'github-token'?: string | undefined;
}

export interface GitHubOptions {
	readonly 'github-token'?: string | undefined;
}

export interface OrgOptions {
	readonly 'org-id'?: string | undefined;
	readonly sf?: string | undefined;
}

export interface ExecutionOptions {
	readonly 'workflow-run-id'?: string | undefined;
	readonly 'workflow-run-attempt'?: string | undefined;
}

/**
 * Salesforce's own default: a deployment that has not finished in half an hour
 * is not going to finish quietly.
 */
export const DEFAULT_WAIT_MINUTES = 33;

/** How long past the CLI's own wait Docket lets the process live. */
const GRACE_MINUTES = 5;

/** What a command needs from the process besides its arguments. */
export interface PipelineContext {
	readonly cwd: string;
	/** Read for `GITHUB_TOKEN`; commands never touch `process.env` themselves. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The only clock in the program, so a run's timing is testable. */
	readonly now: () => Date;
	/** Injected by fixtures to exercise the GitHub path without a network. */
	readonly fetch?: typeof globalThis.fetch;
	readonly githubBaseUrl?: string;
}

/** The exact change a run is about, and the branch it targets. */
export interface ResolvedSource {
	readonly source: PlanSource;
	readonly targetBranch: string | undefined;
	/** Present when GitHub was the source of the SHAs. */
	readonly pullRequest: PullRequestFacts | undefined;
}

/**
 * Where a run's SHAs come from.
 *
 * GitHub is the source of truth when a token is available: §5 Phase A.2 wants
 * the pull request read freshly, and the base and head SHAs resolved from that
 * read rather than from whatever a caller typed. Explicit `--base`/`--head`
 * stay supported for a local run against a repository with no pull request
 * open yet.
 */
export const resolveSource = async (
	options: SourceOptions,
	context: PipelineContext,
	eligibility: 'validatable' | 'merged' = 'validatable',
): Promise<Result<ResolvedSource, DocketError>> => {
	if (options.base !== undefined && options.head !== undefined) {
		const source = planSourceOf(options);
		return source.ok
			? ok({ source: source.value, targetBranch: options['target-branch'], pullRequest: undefined })
			: source;
	}

	const repository = requiredOption(options.repository, '--repository');
	if (!repository.ok) return repository;

	const number = requiredNumber(options['pull-request'], '--pull-request');
	if (!number.ok) return number;

	const client = githubClientOf(options, context);
	if (!client.ok) return client;

	const pullRequest = await readPullRequest(client.value, repository.value, number.value);
	if (!pullRequest.ok) return pullRequest;

	const eligible =
		eligibility === 'merged'
			? requireMergedPullRequest(pullRequest.value)
			: requireValidatablePullRequest(pullRequest.value);
	if (!eligible.ok) return eligible;

	return ok({
		source: {
			repository: repository.value,
			pullRequest: number.value,
			baseSha: eligible.value.baseSha,
			headSha: eligible.value.headSha,
		},
		targetBranch: eligible.value.baseBranch,
		pullRequest: eligible.value,
	});
};

/**
 * The token is read from the environment, never from a flag by default: a
 * token on a command line reaches the shell history and the process list.
 */
export const githubClientOf = (
	options: GitHubOptions,
	context: PipelineContext,
): Result<GitHubClient, DocketError> => {
	const token = options['github-token'] ?? context.env['GITHUB_TOKEN'] ?? context.env['GH_TOKEN'];
	if (token === undefined || token === '') {
		return err(
			docketError(
				ErrorCode.missingOption,
				'GitHub is needed here but no token was found: set GITHUB_TOKEN, or pass --base and --head',
			),
		);
	}

	return ok({
		token,
		...(context.githubBaseUrl === undefined ? {} : { baseUrl: context.githubBaseUrl }),
		...(context.fetch === undefined ? {} : { fetch: context.fetch }),
	});
};

export const planSourceOf = (options: SourceOptions): Result<PlanSource, DocketError> => {
	const repository = requiredOption(options.repository, '--repository');
	if (!repository.ok) return repository;

	const pullRequest = requiredNumber(options['pull-request'], '--pull-request');
	if (!pullRequest.ok) return pullRequest;

	const base = requiredOption(options.base, '--base');
	if (!base.ok) return base;
	const baseSha = parseCommitSha(base.value, '--base', ErrorCode.invalidOption);
	if (!baseSha.ok) return baseSha;

	const head = requiredOption(options.head, '--head');
	if (!head.ok) return head;
	const headSha = parseCommitSha(head.value, '--head', ErrorCode.invalidOption);
	if (!headSha.ok) return headSha;

	return ok({
		repository: repository.value,
		pullRequest: pullRequest.value,
		baseSha: baseSha.value,
		headSha: headSha.value,
	});
};

/**
 * How the run learns which org it is bound to.
 *
 * `--org-id` exists for building a plan without an authenticated CLI — a
 * review, a dry run, a test. It is not a shortcut around verification: a
 * deployment re-resolves the alias and refuses an org that is not this id.
 */
export const orgResolverOf = (options: OrgOptions, cwd: string): OrgIdResolver => {
	const explicit = options['org-id'];
	if (explicit !== undefined && explicit !== '') {
		return async () => parseSalesforceOrgId(explicit, '--org-id', ErrorCode.invalidOption);
	}

	return async (reference) => {
		const org = await resolveOrg({ executable: sfExecutableOf(options), cwd }, reference);
		return org.ok ? ok(org.value.id) : org;
	};
};

export const sfExecutableOf = (options: { readonly sf?: string | undefined }): string => {
	return options.sf ?? DEFAULT_SF_EXECUTABLE;
};

export const waitMinutesOf = (options: { readonly wait?: string | undefined }): Result<number, DocketError> => {
	if (options.wait === undefined) return ok(DEFAULT_WAIT_MINUTES);

	return requiredNumber(options.wait, '--wait');
};

/** A workflow run is an all-or-nothing provenance tuple, never a loose label. */
export const executionOf = (
	options: ExecutionOptions,
): Result<{ readonly executor: RunExecutor; readonly workflow?: RunWorkflow }, DocketError> => {
	const runId = options['workflow-run-id'];
	const attempt = options['workflow-run-attempt'];
	if (runId === undefined && attempt === undefined) return ok({ executor: 'local' });

	const presentRunId = requiredOption(runId, '--workflow-run-id');
	if (!presentRunId.ok) return presentRunId;
	if (!/^[1-9][0-9]*$/.test(presentRunId.value)) {
		return err(docketError(ErrorCode.invalidOption, '--workflow-run-id must be a positive whole number'));
	}

	const runAttempt = requiredNumber(attempt, '--workflow-run-attempt');
	if (!runAttempt.ok) return runAttempt;

	return ok({
		executor: 'github-actions',
		workflow: { runId: presentRunId.value, runAttempt: runAttempt.value },
	});
};

export const expectedPlanIdentityOf = (
	options: { readonly 'expected-plan-identity'?: string | undefined },
): Result<string | undefined, DocketError> => {
	const identity = options['expected-plan-identity'];
	if (identity === undefined) return ok(undefined);
	if (!/^sha256:[0-9a-f]{64}$/.test(identity)) {
		return err(
			docketError(
				ErrorCode.invalidOption,
				'--expected-plan-identity must be a sha256 digest from docket locate-run',
			),
		);
	}

	return ok(identity);
};

/**
 * When the artifacts of this run stop existing.
 *
 * §4 promises no history past GitHub's retention window, and a run that does
 * not say when its own evidence expires leaves the audit projection guessing.
 * A workflow knows this at write time from `GITHUB_RETENTION_DAYS`; a local run
 * has no retention at all and passes nothing.
 */
export const artifactsExpireAtOf = (
	options: { readonly 'artifacts-expire-at'?: string | undefined },
): Result<string | undefined, DocketError> => {
	const value = options['artifacts-expire-at'];
	if (value === undefined) return ok(undefined);

	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		return err(
			docketError(
				ErrorCode.invalidOption,
				'--artifacts-expire-at must be an exact ISO-8601 instant, e.g. 2026-11-14T00:00:00.000Z',
			),
		);
	}

	return ok(value);
};

/** The process is given more time than Salesforce, so the CLI reports first. */
export const timeoutMsOf = (waitMinutes: number): number => (waitMinutes + GRACE_MINUTES) * 60_000;

export const outputDirectoryOf = (
	options: { readonly out?: string | undefined },
	cwd: string,
	fallback: string,
): string => {
	const out = options.out ?? join('.docket', fallback);
	return isAbsolute(out) ? out : join(cwd, out);
};

export const repositoryDirectoryOf = (
	options: { readonly repo?: string | undefined },
	cwd: string,
): string => {
	return options.repo ?? cwd;
};

const requiredNumber = (value: string | undefined, flag: string): Result<number, DocketError> => {
	const present = requiredOption(value, flag);
	if (!present.ok) return present;

	const parsed = Number(present.value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return err(docketError(ErrorCode.invalidOption, `${flag} must be a positive whole number`));
	}

	return ok(parsed);
};
