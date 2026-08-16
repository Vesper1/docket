import { docketError } from '../../shared/result/docket-error.ts';
import type { DocketError, ErrorCode } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';

export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

export function isCommitSha(value: unknown): value is string {
	return typeof value === 'string' && FULL_COMMIT_SHA.test(value);
}

/** Validates an external ref before Git ever receives it as an argument. */
export function parseCommitSha(
	value: unknown,
	label: string,
	code: ErrorCode,
): Result<string, DocketError> {
	return isCommitSha(value)
		? ok(value.toLowerCase())
		: err(docketError(code, `${label} must be a full 40-character commit SHA`));
}
