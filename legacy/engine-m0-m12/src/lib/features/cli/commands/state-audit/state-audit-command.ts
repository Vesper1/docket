import { ok } from '../../../../shared/result/result.ts';
import { MVP_STATE_AUDIT } from '../../../audit/state-contract.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';

/** `docket state-audit` — the runtime state Docket keeps, which is none. */
export const stateAuditCommand = defineCommand({
	name: 'state-audit',
	summary: 'Show the no-database MVP runtime-state contract',
	flags: flagsFor(),
	run: () => ok({ kind: 'state-audit', audit: MVP_STATE_AUDIT }),
});
