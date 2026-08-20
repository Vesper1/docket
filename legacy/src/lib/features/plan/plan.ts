import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { DocketConfig, TestSelection } from '../config/config.ts';
import type { FileChange } from '../git/file-change.ts';
import { collectComponents } from '../metadata/component-set.ts';
import type { ComponentSet, PlannedComponent } from '../metadata/component-set.ts';
import { compareComponents } from '../metadata/metadata-component.ts';
import { DEFAULT_API_VERSION, renderPackageXml } from '../metadata/package-xml.ts';

/**
 * What one run deploys, and where the source bytes come from.
 *
 * `sourceSha` is the commit whose tree is exported and handed to the Salesforce
 * CLI. A deployment deploys the head commit; a rollback deploys the base one,
 * which is the whole difference between the two.
 */
export interface DeploymentPlan {
	readonly kind: 'deploy' | 'rollback';
	readonly baseSha: string;
	readonly headSha: string;
	readonly sourceSha: string;
	readonly org: string;
	readonly tests: TestSelection;
	readonly allowDestructiveChanges: boolean;
	readonly apiVersion: string;
	readonly components: ComponentSet;
	readonly packageXml: string;
	readonly destructiveChangesXml: string | null;
}

/** Whether Salesforce has anything at all to do. */
export const planChangesMetadata = (plan: DeploymentPlan): boolean =>
	plan.components.deployable.length > 0 || plan.components.destructive.length > 0;

/**
 * Turns the exact diff between two commits into a deployable plan.
 *
 * The deletion policy is enforced here rather than at deploy time, so a
 * forbidden deletion stops before any manifest reaches an org.
 */
export const buildPlan = (request: {
	readonly kind: 'deploy' | 'rollback';
	readonly changes: readonly FileChange[];
	readonly config: DocketConfig;
	readonly baseSha: string;
	readonly headSha: string;
}): Result<DeploymentPlan, DocketError> => {
	const collected = collectComponents(request.changes, { sourceRoot: request.config.sourceRoot });
	if (!collected.ok) return collected;

	const components = request.kind === 'rollback' ? invertComponents(collected.value) : collected.value;

	if (components.destructive.length > 0 && !request.config.allowDestructiveChanges) {
		const named = components.destructive.map((component) => `\`${component.member}\``).join(', ');
		return err(
			docketError(
				ErrorCode.destructiveNotAllowed,
				`this ${request.kind} would delete ${named}, but allowDestructiveChanges is false`,
			),
		);
	}

	return ok({
		kind: request.kind,
		baseSha: request.baseSha,
		headSha: request.headSha,
		// A rollback restores the tree the change started from.
		sourceSha: request.kind === 'rollback' ? request.baseSha : request.headSha,
		org: request.config.org,
		tests: request.config.tests,
		allowDestructiveChanges: request.config.allowDestructiveChanges,
		apiVersion: DEFAULT_API_VERSION,
		components,
		packageXml: renderPackageXml(components.deployable, DEFAULT_API_VERSION),
		destructiveChangesXml:
			components.destructive.length === 0
				? null
				: renderPackageXml(components.destructive, DEFAULT_API_VERSION),
	});
};

/**
 * The component-level inverse: what was added is deleted, what was deleted is
 * added back, and what was modified is modified again — to the bytes the
 * deployment started from.
 */
export const invertComponents = (components: ComponentSet): ComponentSet => {
	const deployable: PlannedComponent[] = [];
	const destructive: PlannedComponent[] = [];

	for (const component of components.deployable) {
		if (component.change === 'added') {
			destructive.push({ type: component.type, member: component.member, change: 'deleted' });
		} else {
			deployable.push({ type: component.type, member: component.member, change: 'modified' });
		}
	}
	for (const component of components.destructive) {
		deployable.push({ type: component.type, member: component.member, change: 'added' });
	}

	return {
		deployable: deployable.sort(compareComponents),
		destructive: destructive.sort(compareComponents),
	};
};

/** A human-readable summary, so a plan can be reviewed before it is run. */
export const renderReport = (plan: DeploymentPlan): string => {
	const lines = [
		`# Docket ${plan.kind} plan`,
		'',
		`base    ${plan.baseSha}`,
		`head    ${plan.headSha}`,
		`source  ${plan.sourceSha}`,
		`org     ${plan.org}`,
		`tests   ${plan.tests.mode === 'all' ? 'all local tests' : plan.tests.classes.join(', ')}`,
		'',
	];

	if (!planChangesMetadata(plan)) {
		lines.push('No metadata changes.', '');
		return lines.join('\n');
	}

	if (plan.components.deployable.length > 0) {
		lines.push('## Deploy');
		for (const component of plan.components.deployable) {
			lines.push(`- ${component.change.padEnd(8)} ${component.type} ${component.member}`);
		}
		lines.push('');
	}

	if (plan.components.destructive.length > 0) {
		lines.push('## Delete');
		for (const component of plan.components.destructive) {
			lines.push(`- deleted  ${component.type} ${component.member}`);
		}
		lines.push('');
	}

	return lines.join('\n');
};
