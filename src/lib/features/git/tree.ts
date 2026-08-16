import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { parseCommitSha } from './commit-sha.ts';
import { runGit } from './git-command.ts';

export type GitFileMode = '100644' | '100755';

export type GitPathState =
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'file';
			readonly mode: GitFileMode;
			readonly contents: string;
			readonly blobSha: string;
	  };

/** Reads one regular file from one exact tree, while preserving its Git mode. */
export async function readPathAtCommit(
	cwd: string,
	shaInput: string,
	path: string,
): Promise<Result<GitPathState, DocketError>> {
	const sha = parseCommitSha(shaInput, 'commit SHA', ErrorCode.gitFailed);
	if (!sha.ok) return sha;

	const safePath = requireRepositoryPath(path);
	if (!safePath.ok) return safePath;

	const listed = await runGit(
		['ls-tree', '-z', '--full-name', '--end-of-options', sha.value, '--', safePath.value],
		{ cwd },
	);
	if (listed.startError !== null || listed.exitCode !== 0) {
		return err(gitFailure(`cannot inspect \`${safePath.value}\` at ${sha.value}`, listed));
	}
	if (listed.stdout === '') return ok({ kind: 'absent' });

	const entries = listed.stdout.split('\0').filter((entry) => entry !== '');
	if (entries.length !== 1) {
		return err(
			docketError(
				ErrorCode.gitFailed,
				`cannot inspect \`${safePath.value}\` at ${sha.value}: Git returned ${entries.length} entries`,
			),
		);
	}

	const parsed = parseTreeEntry(entries[0] ?? '', safePath.value, sha.value);
	if (!parsed.ok) return parsed;

	const blob = await runGit(['cat-file', 'blob', parsed.value.blobSha], { cwd });
	if (blob.startError !== null || blob.exitCode !== 0) {
		return err(gitFailure(`cannot read \`${safePath.value}\` at ${sha.value}`, blob));
	}

	return ok({
		kind: 'file',
		mode: parsed.value.mode,
		contents: blob.stdout,
		blobSha: parsed.value.blobSha,
	});
}

/** Lists repository-relative files below one path in one exact commit. */
export async function listPathsAtCommit(
	cwd: string,
	shaInput: string,
	prefix: string,
): Promise<Result<readonly string[], DocketError>> {
	const sha = parseCommitSha(shaInput, 'commit SHA', ErrorCode.gitFailed);
	if (!sha.ok) return sha;

	const safePrefix = requireRepositoryPath(prefix);
	if (!safePrefix.ok) return safePrefix;

	const listed = await runGit(
		['ls-tree', '-r', '-z', '--name-only', '--full-name', '--end-of-options', sha.value, '--', safePrefix.value],
		{ cwd },
	);
	if (listed.startError !== null || listed.exitCode !== 0) {
		return err(gitFailure(`cannot list \`${safePrefix.value}\` at ${sha.value}`, listed));
	}

	const paths = listed.stdout.split('\0');
	if (paths.at(-1) === '') paths.pop();
	return ok(paths);
}

function parseTreeEntry(
	entry: string,
	expectedPath: string,
	sha: string,
): Result<{ readonly mode: GitFileMode; readonly blobSha: string }, DocketError> {
	const tab = entry.indexOf('\t');
	const header = tab < 0 ? '' : entry.slice(0, tab);
	const path = tab < 0 ? '' : entry.slice(tab + 1);
	const [mode, type, blobSha, extra] = header.split(' ');

	if (
		path !== expectedPath ||
		extra !== undefined ||
		(mode !== '100644' && mode !== '100755') ||
		type !== 'blob' ||
		typeof blobSha !== 'string' ||
		!/^[0-9a-f]{40}$/.test(blobSha)
	) {
		return err(
			docketError(
				ErrorCode.gitFailed,
				`cannot inspect \`${expectedPath}\` at ${sha}: it is not one regular Git file`,
			),
		);
	}

	return ok({ mode, blobSha });
}

function requireRepositoryPath(path: string): Result<string, DocketError> {
	if (
		path === '' ||
		path.startsWith('/') ||
		path.endsWith('/') ||
		path.includes('\0') ||
		path.split('/').some((part) => part === '' || part === '.' || part === '..')
	) {
		return err(docketError(ErrorCode.gitFailed, `invalid repository path: ${JSON.stringify(path)}`));
	}

	return ok(path);
}

function gitFailure(
	prefix: string,
	result: { readonly exitCode: number | null; readonly startError: string | null; readonly stderr: string },
): DocketError {
	return docketError(
		ErrorCode.gitFailed,
		`${prefix}: ${result.startError ?? result.stderr.trim().split('\n')[0] ?? `git exited ${result.exitCode}`}`,
	);
}
