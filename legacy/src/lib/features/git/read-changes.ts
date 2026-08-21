import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { ChangeStatus, FileChange } from './file-change.ts';
import { parseCommitSha } from './commit-sha.ts';
import { runGit } from './git-command.ts';

export interface ChangeRequest {
	/** A repository that already contains both commits. */
	readonly cwd: string;
	/** Full SHA of the commit the change starts from. */
	readonly baseSha: string;
	/** Full SHA of the commit the change ends at. */
	readonly headSha: string;
}

/**
 * Lists what changed between the two exact commits it is given.
 *
 * The commits are compared directly rather than through their merge base: a
 * run is identified by its SHA pair, and validation separately requires the PR
 * to stay up to date with its target branch. Neither HEAD nor the working tree
 * is read, so uncommitted or untracked files in a local workspace cannot reach
 * a deployment plan.
 */
export const readChanges = async (
	request: ChangeRequest,
): Promise<Result<readonly FileChange[], DocketError>> => {
	const base = parseCommitSha(request.baseSha, 'base SHA', ErrorCode.gitFailed);
	if (!base.ok) return base;
	const head = parseCommitSha(request.headSha, 'head SHA', ErrorCode.gitFailed);
	if (!head.ok) return head;

	// `-z` because a repository-relative path may contain a space, a quote or a
	// newline, and without it git escapes such paths instead of printing them.
	// `--end-of-options` separates the revision arguments from Git options; the
	// trailing `--` then separates them from any path filter.
	const result = await runGit(
		[
			'diff',
			'--name-status',
			'--find-renames',
			'-z',
			'--end-of-options',
			base.value,
			head.value,
			'--',
		],
		{ cwd: request.cwd },
	);

	if (result.startError !== null || result.exitCode !== 0) {
		return err(
			docketError(
				ErrorCode.gitFailed,
				`git diff failed (${result.exitCode}): ${result.startError ?? firstLine(result.stderr)}`,
			),
		);
	}

	return parseNameStatus(result.stdout);
};

/**
 * git's status letters, mapped only as far as Docket can honestly classify
 * them. An unmapped letter — a copy, a type change, an unmerged path — is a
 * refusal rather than a skipped record: silently dropping one would produce a
 * manifest that omits a real change.
 */
const STATUS_BY_LETTER: Readonly<Record<string, ChangeStatus>> = {
	A: 'added',
	M: 'modified',
	D: 'deleted',
	R: 'renamed',
};

/**
 * `--name-status -z` emits a marker followed by one path, except for a rename,
 * where the marker carries a similarity score (`R100`) and is followed by the
 * old path and then the new one.
 */
const parseNameStatus = (stdout: string): Result<readonly FileChange[], DocketError> => {
	// Every field is NUL-terminated, so the split leaves one empty tail field.
	const fields = stdout.split('\0');
	if (fields.at(-1) === '') fields.pop();

	const changes: FileChange[] = [];
	let index = 0;

	while (index < fields.length) {
		const marker = fields[index];
		if (marker === undefined || marker === '') return err(incompleteRecord());
		index += 1;

		const status = STATUS_BY_LETTER[marker.charAt(0)];
		if (status === undefined) {
			return err(docketError(ErrorCode.unsupportedChange, `unsupported change status: ${marker}`));
		}

		if (status === 'renamed') {
			const previousPath = fields[index];
			const path = fields[index + 1];
			if (!previousPath || !path) return err(incompleteRecord());
			index += 2;
			changes.push({ status, path, previousPath });
			continue;
		}

		const path = fields[index];
		if (!path) return err(incompleteRecord());
		index += 1;
		changes.push({ status, path });
	}

	return ok(changes);
};

const incompleteRecord = (): DocketError => {
	return docketError(ErrorCode.gitFailed, 'git diff produced an incomplete record');
};

/** git states the diagnosis on the first line and adds advice below it. */
const firstLine = (stderr: string): string => stderr.trim().split('\n')[0] ?? '';
