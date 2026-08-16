import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { parseCommitSha } from './commit-sha.ts';
import { runGit } from './git-command.ts';

export interface FileAtCommit {
	readonly cwd: string;
	/** The commit to read from — never a branch name a PR could move. */
	readonly sha: string;
	/** Repository-relative path. */
	readonly path: string;
}

/**
 * Reads one file exactly as it exists in one commit.
 *
 * This is how trusted configuration is obtained (§4): `docket.yml` comes from
 * the base commit, so a pull request cannot edit the commands that will later
 * run with deployment credentials. Reading it from the working tree instead
 * would hand that power to whoever opened the pull request.
 */
export async function readFileAtCommit(request: FileAtCommit): Promise<Result<string, DocketError>> {
	const sha = parseCommitSha(request.sha, 'commit SHA', ErrorCode.gitFailed);
	if (!sha.ok) return sha;

	const result = await runGit(['show', '--end-of-options', `${sha.value}:${request.path}`], {
		cwd: request.cwd,
	});

	if (result.startError !== null || result.exitCode !== 0) {
		return err(
			docketError(
				ErrorCode.gitFailed,
				`cannot read \`${request.path}\` at ${sha.value}: ${result.startError ?? firstLine(result.stderr)}`,
			),
		);
	}

	return ok(result.stdout);
}

function firstLine(stderr: string): string {
	return stderr.trim().split('\n')[0] ?? '';
}
