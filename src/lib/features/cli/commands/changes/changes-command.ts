import { ErrorCode } from '../../../../shared/result/docket-error.ts';
import { ok } from '../../../../shared/result/result.ts';
import { parseCommitSha } from '../../../git/commit-sha.ts';
import { readChanges } from '../../../git/read-changes.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';

const flags = flagsFor('repo', 'base', 'head');

export interface ChangesContext {
	/** Where the process was started, used when `--repo` is not given. */
	readonly cwd: string;
}

/**
 * `docket changes` — what a plan would be built from, and nothing else.
 *
 * It exists so the exact-diff step can be inspected on its own, before any
 * manifest is generated: if this command refuses a ref, nothing downstream
 * gets the chance to invent one.
 */
export const changesCommand = defineCommand({
	name: 'changes',
	summary: 'List the metadata changes between two exact commits',
	flags,
	run: async (options, context: ChangesContext) => {
		const base = requiredOption(options.base, '--base');
		if (!base.ok) return base;
		const baseSha = parseCommitSha(base.value, '--base', ErrorCode.invalidOption);
		if (!baseSha.ok) return baseSha;

		const head = requiredOption(options.head, '--head');
		if (!head.ok) return head;
		const headSha = parseCommitSha(head.value, '--head', ErrorCode.invalidOption);
		if (!headSha.ok) return headSha;

		const result = await readChanges({
			cwd: options.repo ?? context.cwd,
			baseSha: baseSha.value,
			headSha: headSha.value,
		});

		return result.ok ? ok({ kind: 'changes', changes: result.value }) : result;
	},
});
