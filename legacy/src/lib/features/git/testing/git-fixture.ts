import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runGit } from '../git-command.ts';

/** A working tree as a map of repository-relative path to file contents. */
export type TreeSnapshot = Readonly<Record<string, string>>;

export interface GitFixture {
	/** Absolute path to the temporary repository. */
	readonly directory: string;
	/** Full 40-character SHA of the base commit. */
	readonly baseSha: string;
	/** Full 40-character SHA of the head commit. */
	readonly headSha: string;
	/** Deletes the temporary repository. Safe to call more than once. */
	remove(): Promise<void>;
}

export interface GitFixtureInput {
	readonly base: TreeSnapshot;
	readonly head: TreeSnapshot;
}

/**
 * Builds a throwaway repository with exactly two commits.
 *
 * The head commit is the base tree transformed into the head tree, so a path
 * present only in `base` is a deletion, present only in `head` is an addition,
 * and present in both with different contents is a modification. Renames are
 * left for git itself to detect.
 *
 * Commit identity is pinned so a fixture is reproducible, but tests must still
 * treat the SHAs as opaque.
 */
export const createGitFixture = async (input: GitFixtureInput): Promise<GitFixture> => {
	const directory = await mkdtemp(join(tmpdir(), 'docket-git-'));

	try {
		await git(directory, ['init', '--quiet', '--initial-branch=main']);
		await writeTree(directory, input.base);
		const baseSha = await commit(directory, 'base');

		await applyTree(directory, input.base, input.head);
		const headSha = await commit(directory, 'head');

		return {
			directory,
			baseSha,
			headSha,
			remove: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
};

/**
 * Fixed author, committer and dates. Without these the fixture would inherit
 * the machine's identity and the current clock, and identical inputs would
 * produce different commit SHAs on every run.
 */
const FIXED_IDENTITY = {
	GIT_AUTHOR_NAME: 'Docket Fixture',
	GIT_AUTHOR_EMAIL: 'fixture@docket.invalid',
	GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'Docket Fixture',
	GIT_COMMITTER_EMAIL: 'fixture@docket.invalid',
	GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
} as const;

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
	const result = await runGit(args, { cwd, env: FIXED_IDENTITY });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`);
	}
	return result.stdout;
};

const writeTree = async (directory: string, tree: TreeSnapshot): Promise<void> => {
	for (const [path, contents] of Object.entries(tree)) {
		const absolute = join(directory, path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, contents, 'utf8');
	}
};

/** Turns the base tree into the head tree, removing whatever head dropped. */
const applyTree = async (directory: string, base: TreeSnapshot, head: TreeSnapshot): Promise<void> => {
	for (const path of Object.keys(base)) {
		if (!(path in head)) await rm(join(directory, path), { force: true });
	}
	await writeTree(directory, head);
};

const commit = async (directory: string, message: string): Promise<string> => {
	await git(directory, ['add', '--all']);
	await git(directory, ['commit', '--quiet', '--allow-empty', '--message', message]);
	return (await git(directory, ['rev-parse', 'HEAD'])).trim();
};
