import type { DocketError } from '../../../shared/result/docket-error.ts';
import { ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import { MVP_STATE_AUDIT } from '../../audit/state-contract.ts';
import type { CliData } from '../render.ts';

export function stateAuditCommand(): Result<CliData, DocketError> {
	return ok({ kind: 'state-audit', audit: MVP_STATE_AUDIT });
}
