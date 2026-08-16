import { isAbsolute, join } from 'node:path';

import { docketError, ErrorCode } from '../../../shared/result/docket-error.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { err, ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import {
	createCompensatingPullRequest,
	readBranchHead,
} from '../../github/rollback-pull-request.ts';
import { parseCommitSha } from '../../git/commit-sha.ts';
import {
	buildRollbackProposal,
	rollbackTargetBranch,
	writeRollbackArtifacts,
} from '../../rollback/rollback-plan.ts';
import { selectRollbackSource } from '../../rollback/select-run.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import {
	githubClientOf,
	outputDirectoryOf,
	repositoryDirectoryOf,
} from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

/** Select, calculate, and optionally publish a compensating rollback PR. */
export async function rollbackCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const directory = requiredOption(options.run, '--run');
	if (!directory.ok) return directory;

	const absolute = isAbsolute(directory.value) ? directory.value : join(context.cwd, directory.value);
	const source = await selectRollbackSource(absolute);
	if (!source.ok) return source;

	if (
		options.repository !== undefined &&
		options.repository !== source.value.plan.source.repository
	) {
		return err(
			docketError(
				ErrorCode.rollbackSourceInvalid,
				`cannot start rollback: --repository is ${options.repository}, but the run belongs to ${source.value.plan.source.repository}`,
			),
		);
	}

	const createPullRequest = options['create-pr'] === true;
	if (!createPullRequest && options.head === undefined) {
		// Preserve M11.1 as a useful inspection step. Calculation starts only
		// once the caller names the current exact target commit.
		return ok({ kind: 'rollback-source', run: source.value, directory: absolute });
	}
	if (createPullRequest && options.head !== undefined) {
		return err(
			docketError(
				ErrorCode.invalidOption,
				'--create-pr reads the target branch freshly from GitHub; do not also pass --head',
			),
		);
	}

	const repositoryDirectory = repositoryDirectoryOf(options, context.cwd);
	let currentBaseSha: string;
	let client: ReturnType<typeof githubClientOf> | undefined;
	if (createPullRequest) {
		client = githubClientOf(options, context);
		if (!client.ok) return client;
		const branch = await rollbackTargetBranch(repositoryDirectory, source.value);
		if (!branch.ok) return branch;
		const current = await readBranchHead(
			client.value,
			source.value.plan.source.repository,
			branch.value,
		);
		if (!current.ok) return current;
		currentBaseSha = current.value;
	} else {
		const parsed = parseCommitSha(options.head, '--head', ErrorCode.invalidOption);
		if (!parsed.ok) return parsed;
		currentBaseSha = parsed.value;
	}

	const proposal = await buildRollbackProposal({
		repositoryDirectory,
		sourceRun: source.value,
		currentBaseSha,
	});
	if (!proposal.ok) return proposal;

	let outputDirectory: string | null = null;
	if (options.out !== undefined) {
		outputDirectory = outputDirectoryOf(options, context.cwd, 'rollback');
		const written = await writeRollbackArtifacts(outputDirectory, proposal.value);
		if (!written.ok) return written;
	}

	if (!createPullRequest) {
		return ok({
			kind: 'rollback-plan',
			plan: proposal.value.plan,
			report: proposal.value.report,
			directory: outputDirectory,
		});
	}

	if (client === undefined || !client.ok) {
		return err(docketError(ErrorCode.githubFailed, 'GitHub client was not initialized'));
	}
	const pullRequest = await createCompensatingPullRequest(client.value, proposal.value);
	if (!pullRequest.ok) return pullRequest;

	return ok({
		kind: 'rollback-pr',
		pullRequest: pullRequest.value,
		plan: proposal.value.plan,
		directory: outputDirectory,
	});
}
