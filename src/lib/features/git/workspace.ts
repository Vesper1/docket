import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../../shared/process/run-process.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { parseCommitSha } from './commit-sha.ts';
import { runGit } from './git-command.ts';

export interface Workspace {
	/** Absolute path to the exported tree. */
	readonly directory: string;
	/** The commit this tree is. */
	readonly sha: string;
	/** Deletes the workspace. Safe to call more than once. */
	remove(): Promise<void>;
}

export interface WorkspaceRequest {
	/** The repository to export from. */
	readonly cwd: string;
	readonly sha: string;
}

/**
 * Exports one commit into a clean directory of its own.
 *
 * `git archive` rather than a checkout: it writes exactly the tree of that
 * commit and nothing else, so uncommitted edits, untracked files and stale
 * build output in the developer's own working tree cannot reach a run (§4).
 * The result has no `.git` either, so nothing downstream can quietly consult
 * a branch instead of the commit it was given.
 */
export const createWorkspace = async (request: WorkspaceRequest): Promise<Result<Workspace, DocketError>> => {
	const sha = parseCommitSha(request.sha, 'commit SHA', ErrorCode.gitFailed);
	if (!sha.ok) return sha;

	const directory = await mkdtemp(join(tmpdir(), 'docket-workspace-'));
	const archive = join(directory, 'tree.tar');
	const remove = () => rm(directory, { recursive: true, force: true });

	const exported = await runGit(['archive', '--format=tar', '--output', archive, '--end-of-options', sha.value], {
		cwd: request.cwd,
	});

	if (exported.startError !== null || exported.exitCode !== 0) {
		await remove();
		return err(
			docketError(
				ErrorCode.gitFailed,
				`cannot export ${sha.value}: ${exported.startError ?? firstLine(exported.stderr)}`,
			),
		);
	}

	const extracted = await runProcess('tar', ['-xf', archive, '-C', directory]);
	if (extracted.startError !== null || extracted.exitCode !== 0) {
		await remove();
		return err(
			docketError(
				ErrorCode.gitFailed,
				`cannot unpack ${sha.value}: ${extracted.startError ?? firstLine(extracted.stderr)}`,
			),
		);
	}

	await rm(archive, { force: true });

	return ok({ directory, sha: sha.value, remove });
};

/** Runs `work` in a fresh workspace and removes it whatever happens. */
export const withWorkspace = async <T>(
	request: WorkspaceRequest,
	work: (workspace: Workspace) => Promise<Result<T, DocketError>>,
): Promise<Result<T, DocketError>> => {
	const workspace = await createWorkspace(request);
	if (!workspace.ok) return workspace;

	try {
		return await work(workspace.value);
	} finally {
		// §4: a temporary workspace is cleaned up after success, failure and
		// cancellation alike.
		await workspace.value.remove();
	}
};

const firstLine = (stderr: string): string => stderr.trim().split('\n')[0] ?? '';
