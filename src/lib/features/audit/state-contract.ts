export const STATE_AUDIT_SCHEMA = 'docket.state-audit/v1';

export type StateCapability =
	| 'configuration'
	| 'validation-handoff'
	| 'merge-gate'
	| 'manual-steps'
	| 'deployment-lock'
	| 'deployment-history'
	| 'rollback';

export interface StateAudit {
	readonly schema: typeof STATE_AUDIT_SCHEMA;
	readonly status: 'passed-with-limitations';
	readonly database: 'none';
	readonly capabilities: readonly {
		readonly capability: StateCapability;
		readonly backend: string;
	}[];
	readonly limitations: readonly string[];
}

/** M12.4: the explicit runtime-state map for the no-database code MVP. */
export const MVP_STATE_AUDIT: StateAudit = {
	schema: STATE_AUDIT_SCHEMA,
	status: 'passed-with-limitations',
	database: 'none',
	capabilities: [
		{ capability: 'configuration', backend: 'Git docket.yml at an exact base commit' },
		{
			capability: 'validation-handoff',
			backend: 'immutable GitHub Actions artifact selected by a GitHub Check Run',
		},
		{ capability: 'merge-gate', backend: 'GitHub Check Runs on the exact PR head SHA' },
		{
			capability: 'manual-steps',
			backend: 'GitHub Check Runs plus immutable completion artifacts',
		},
		{
			capability: 'deployment-lock',
			backend: 'job-scoped GitHub Actions concurrency group keyed by verified org id',
		},
		{ capability: 'deployment-history', backend: 'verified non-secret run artifacts' },
		{
			capability: 'rollback',
			backend: 'verified deployment artifact plus Git commits and a compensating GitHub PR',
		},
	],
	limitations: [
		'GitHub Actions concurrency does not serialize a direct local CLI deployment.',
		'History and rollback are available only while run artifacts are retained or separately exported.',
		'GitHub queue: max admits at most 100 pending deployments in one concurrency group.',
	],
};

export function renderStateAudit(audit: StateAudit = MVP_STATE_AUDIT): string {
	return [
		'# Docket MVP state audit',
		'',
		`Database: ${audit.database}`,
		`Verdict: ${audit.status}`,
		'',
		...audit.capabilities.map((entry) => `- ${entry.capability}: ${entry.backend}`),
		'',
		'Known limitations:',
		...audit.limitations.map((limitation) => `- ${limitation}`),
		'',
	].join('\n');
}
