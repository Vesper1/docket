import { readChanges } from '../../git/read-changes.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import type { CliData } from '../render.ts';
import { parseCommitSha } from '../../git/commit-sha.ts';
import { ErrorCode } from '../../../shared/result/docket-error.ts';
import { requiredOption } from './option.ts';

export interface ChangesOptions {
	readonly repo?: string | undefined;
	readonly base?: string | undefined;
	readonly head?: string | undefined;
}

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
export async function changesCommand(
	options: ChangesOptions,
	context: ChangesContext,
): Promise<Result<CliData, DocketError>> {
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
}
