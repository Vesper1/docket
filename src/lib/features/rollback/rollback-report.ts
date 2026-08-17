import type { RunRecord } from '../run/run-record.ts';
import type { RollbackOperation, RollbackPlan } from './rollback-plan.ts';

/** Names the branch after the exact commits involved, so two proposals differ. */
export function rollbackBranch(source: RunRecord, currentBaseSha: string): string {
	return `docket/rollback-pr${source.plan.source.pullRequest}-${source.plan.source.headSha.slice(0, 8)}-${currentBaseSha.slice(0, 8)}`;
}

/**
 * The pull request body: where this change came from, and what still has to
 * happen to it. A rollback is an ordinary pull request, not a side door.
 */
export function rollbackBody(
	source: RunRecord,
	currentBaseSha: string,
	operations: readonly RollbackOperation[],
): string {
	const lines = [
		'This compensating pull request was calculated by Docket.',
		'',
		`- Source PR: #${source.plan.source.pullRequest}`,
		`- Source plan: \`${source.plan.identity}\``,
		`- Salesforce deployment: \`${oneLine(source.deployment?.deploymentId ?? 'unknown')}\``,
		`- Target base: \`${currentBaseSha}\``,
		'',
		'It must pass the ordinary Docket validation check, be merged manually, and then use the ordinary post-merge deployment workflow.',
		'',
		'File operations:',
		...operations.map((operation) => `- ${operation.kind} \`${operation.path}\``),
	];

	return `${lines.join('\n')}\n`;
}

/** The reviewable summary: what is undone, where, and whether policy allows it. */
export function renderRollbackReport(plan: RollbackPlan): string {
	const lines = [
		'# Docket rollback proposal',
		'',
		`- Source pull request: #${plan.source.pullRequest}`,
		`- Source deployment: \`${plan.source.deploymentId}\``,
		`- Target: \`${plan.target.environmentId}\` / \`${plan.target.orgId}\``,
		`- Target base: \`${plan.target.baseSha}\``,
		`- Rollback identity: \`${plan.identity}\``,
		'',
		'## Components',
		'',
		'| Type | Member | Change |',
		'| --- | --- | --- |',
		...[...plan.components.deployable, ...plan.components.destructive].map(
			(component) => `| ${component.type} | ${component.member} | ${component.change} |`,
		),
		'',
		'## Files',
		'',
		'| Operation | Path | Content |',
		'| --- | --- | --- |',
		...plan.operations.map(
			(operation) =>
				`| ${operation.kind} | ${operation.path.replaceAll('|', '\\|')} | ${operation.contentDigest ?? 'delete'} |`,
		),
		'',
		plan.normalFlow.ready
			? 'The current environment policy admits this inverse through the normal PR flow.'
			: 'Blocked: the inverse deletes metadata, but the current environment policy forbids destructive changes.',
		'',
	];

	return lines.join('\n');
}

/** A recorded id is untrusted text; it never breaks the line it sits on. */
function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, ' ');
}
