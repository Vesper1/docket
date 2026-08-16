import { canonicalJson, digestOf } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { EnvironmentConfig, TestSelection } from '../config/docket-config.ts';
import type { FileChange } from '../git/file-change.ts';
import { collectComponents } from '../metadata/component-set.ts';
import type { ComponentSet } from '../metadata/component-set.ts';
import { renderPackageXml } from '../metadata/package-xml.ts';
import { PLAN_SCHEMA } from './deployment-plan.ts';
import type { ManifestDigests, PlanArtifacts, PlanSource, PlanTarget } from './deployment-plan.ts';
import { renderReport } from './report.ts';

export interface PlanRequest {
	readonly source: PlanSource;
	readonly environment: EnvironmentConfig;
	/** The Salesforce org id `environment.org` resolved to. */
	readonly orgId: string;
	readonly apiVersion: string;
	readonly sourceRoot: string;
	readonly changes: readonly FileChange[];
}

/**
 * Builds the whole deployment plan from one exact change set.
 *
 * Nothing here touches the network, a clock or the filesystem, so the same
 * inputs always produce the same artifacts — the property M4.5 checks and the
 * reason a plan can be compared across two machines at all.
 */
export function buildPlan(request: PlanRequest): Result<PlanArtifacts, DocketError> {
	const components = collectComponents(request.changes, { sourceRoot: request.sourceRoot });
	if (!components.ok) return components;

	const policy = enforceDeletionPolicy(components.value, request.environment);
	if (!policy.ok) return policy;

	const packageXml = renderPackageXml(components.value.deployable, request.apiVersion);
	const destructiveChangesXml =
		components.value.destructive.length === 0
			? undefined
			: renderPackageXml(components.value.destructive, request.apiVersion);

	const manifestDigests: ManifestDigests = {
		packageXml: digestOf(packageXml),
		destructiveChangesXml:
			destructiveChangesXml === undefined ? null : digestOf(destructiveChangesXml),
	};

	const target: PlanTarget = {
		environmentId: request.environment.id,
		org: request.environment.org,
		orgId: request.orgId,
	};

	const plan = {
		schema: PLAN_SCHEMA,
		source: request.source,
		target,
		tests: request.environment.tests,
		allowDestructiveChanges: request.environment.allowDestructiveChanges,
		apiVersion: request.apiVersion,
		components: components.value,
		steps: {
			gates: request.environment.gates,
			preDeployment: request.environment.preDeployment,
			postDeployment: request.environment.postDeployment,
		},
		manifestDigests,
		identity: planIdentity({
			source: request.source,
			orgId: request.orgId,
			tests: request.environment.tests,
			allowDestructiveChanges: request.environment.allowDestructiveChanges,
			manifestDigests,
		}),
	} as const;

	return ok({
		plan,
		packageXml,
		destructiveChangesXml,
		report: renderReport(plan),
	});
}

export interface PlanIdentityInput {
	readonly source: PlanSource;
	readonly orgId: string;
	readonly tests: TestSelection;
	readonly allowDestructiveChanges: boolean;
	readonly manifestDigests: ManifestDigests;
}

/**
 * The identity tuple of §5 Phase C.6, hashed.
 *
 * Deliberately narrower than the plan itself: it holds what must not change
 * between validation and deployment. A field left out of this hash is a field
 * a merged PR could alter without invalidating its green check.
 */
export function planIdentity(input: PlanIdentityInput): string {
	return digestOf(
		canonicalJson({
			repository: input.source.repository,
			pullRequest: input.source.pullRequest,
			baseSha: input.source.baseSha,
			headSha: input.source.headSha,
			orgId: input.orgId,
			tests: input.tests,
			allowDestructiveChanges: input.allowDestructiveChanges,
			manifestDigests: input.manifestDigests,
		}),
	);
}

/**
 * Deleting metadata is refused unless the environment says otherwise.
 *
 * Fail closed: the run stops before a manifest is written, so an environment
 * with the policy off cannot produce a destructive artifact at all, whatever a
 * later step decides to do with it.
 */
function enforceDeletionPolicy(
	components: ComponentSet,
	environment: EnvironmentConfig,
): Result<ComponentSet, DocketError> {
	if (components.destructive.length === 0 || environment.allowDestructiveChanges) {
		return ok(components);
	}

	const names = components.destructive
		.map((component) => `${component.type}:${component.member}`)
		.join(', ');

	return err(
		docketError(
			ErrorCode.destructiveNotAllowed,
			`environment ${environment.id} forbids destructive changes, but the plan deletes ${names}`,
		),
	);
}
