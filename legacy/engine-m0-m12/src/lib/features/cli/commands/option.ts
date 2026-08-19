import { docketError, ErrorCode } from '../../../shared/result/docket-error.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { err, ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';

/**
 * Turns an absent flag into a refusal instead of a default.
 *
 * Guessing a ref, an environment or a repository is how a run ends up
 * deploying something nobody asked for, so every command states what it needs
 * and stops when it is missing.
 */
export const requiredOption = (value: string | undefined, flag: string): Result<string, DocketError> => {
	if (value === undefined || value === '') {
		return err(docketError(ErrorCode.missingOption, `missing required option: ${flag}`));
	}

	return ok(value);
};
