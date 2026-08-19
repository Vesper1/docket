import { docketError } from '../../shared/result/docket-error.ts';
import type { DocketError, ErrorCode } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';

/** Salesforce record ids are 15 or 18 alphanumerics; org ids use key prefix 00D. */
const SALESFORCE_ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

export const isSalesforceOrgId = (value: unknown): value is string => {
	return typeof value === 'string' && SALESFORCE_ORG_ID.test(value);
};

export const parseSalesforceOrgId = (
	value: unknown,
	where: string,
	code: ErrorCode,
): Result<string, DocketError> => {
	return isSalesforceOrgId(value)
		? ok(value)
		: err(docketError(code, `${where} must be a 15- or 18-character Salesforce org id starting with 00D`));
};
