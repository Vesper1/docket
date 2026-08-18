import type { GateDefinition, StepDefinition, TestSelection } from '../config/docket-config.ts';
import type { ComponentSet } from '../metadata/component-set.ts';

/** Written into every plan so a later reader can refuse a shape it predates. */
export const PLAN_SCHEMA = 'docket.plan/v1';

/** The exact change a plan was built from. */
export interface PlanSource {
	/** `owner/name`, as GitHub spells it. */
	readonly repository: string;
	readonly pullRequest: number;
	/** Full 40-character SHA. */
	readonly baseSha: string;
	/** Full 40-character SHA. */
	readonly headSha: string;
}

/** Where the plan is allowed to go. */
export interface PlanTarget {
	/** The `docket.yml` environment id this run was asked for. */
	readonly environmentId: string;
	/** The configured org reference — an alias or username, never a secret. */
	readonly org: string;
	/** The Salesforce org id that reference resolved to. */
	readonly orgId: string;
}

/**
 * The gates and steps this plan will run, copied out of the trusted
 * configuration so the report and the record show them. Deployment does not
 * take them from here: it re-reads them from the base commit and refuses a
 * plan whose steps no longer match (§4).
 */
export interface PlanSteps {
	readonly gates: readonly GateDefinition[];
	readonly preDeployment: readonly StepDefinition[];
	readonly postDeployment: readonly StepDefinition[];
}

/**
 * Whether the plan asks Salesforce for anything at all.
 *
 * A pull request that touches no metadata — documentation, CI configuration,
 * the vendored engine — produces a plan with both lists empty. Salesforce
 * refuses such a request outright ("No local changes to deploy"), so the run
 * must not make it: an empty plan is a legitimate outcome that still has to
 * reach a green check, or the change could never be merged.
 */
export function planChangesMetadata(plan: DeploymentPlan): boolean {
	return plan.components.deployable.length > 0 || plan.components.destructive.length > 0;
}

export interface ManifestDigests {
	readonly packageXml: string;
	/** `null` when the plan deletes nothing, so its absence is explicit. */
	readonly destructiveChangesXml: string | null;
}

/**
 * Everything a deployment needs, decided once and never recomputed.
 *
 * The post-merge deployment does not re-derive any of this: it deploys exactly
 * what validation approved, which is only meaningful because `identity` binds
 * the whole tuple together.
 */
export interface DeploymentPlan {
	readonly schema: typeof PLAN_SCHEMA;
	readonly source: PlanSource;
	readonly target: PlanTarget;
	readonly tests: TestSelection;
	readonly allowDestructiveChanges: boolean;
	readonly apiVersion: string;
	readonly components: ComponentSet;
	readonly steps: PlanSteps;
	readonly manifestDigests: ManifestDigests;
	/**
	 * The validated-plan identity of §5 Phase C.6: repository, pull request,
	 * both SHAs, org id, tests, deletion policy and manifest digests, hashed
	 * together. Deployment refuses to run when this no longer matches.
	 */
	readonly identity: string;
}

/** A plan plus the artifact files that belong to it. */
export interface PlanArtifacts {
	readonly plan: DeploymentPlan;
	readonly packageXml: string;
	/** Present only when the plan deletes something. */
	readonly destructiveChangesXml: string | undefined;
	readonly report: string;
}
