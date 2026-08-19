import type { DeploymentPlan } from '../plan/deployment-plan.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import type { StepResult, ValidationRecord, Verdict } from '../validation/validation-record.ts';

export const RUN_SCHEMA = 'docket.run/v1';

/** What a run was for. A rollback is a deployment with a different origin. */
export type RunKind = 'validate' | 'deploy' | 'rollback';

/** Where a run happened, so a local run is never mistaken for a gated one. */
export type RunExecutor = 'local' | 'github-actions';

export interface RunTiming {
	/** ISO-8601, supplied by the caller — nothing here reads a clock itself. */
	readonly startedAt: string;
	readonly finishedAt: string;
}

/**
 * The GitHub side of a run, when there is one.
 *
 * The workflow run id is what the post-merge deployment uses to fetch the
 * validation artifacts of the exact run that produced the green check.
 */
export interface RunWorkflow {
	readonly runId: string;
	readonly runAttempt: number;
}

/**
 * `run.json` — the immutable record of one run.
 *
 * It exists instead of a database (§4): the post-merge deployment, the audit
 * trail and a later rollback all read this file, so it must contain the whole
 * decision and none of the credentials that carried it out.
 */
export interface RunRecord {
	readonly schema: typeof RUN_SCHEMA;
	readonly kind: RunKind;
	readonly executor: RunExecutor;
	readonly status: Verdict;
	readonly timing: RunTiming;
	readonly plan: DeploymentPlan;
	/** Present for a validation run, and carried forward by the deployment. */
	readonly validation: ValidationRecord | null;
	/** Present only once a real deployment has run against the org. */
	readonly deployment: DeploymentOutcome | null;
	/** Post-deployment steps and anything else that ran after the deployment. */
	readonly steps: readonly StepResult[];
	readonly workflow: RunWorkflow | null;
	/** The commit GitHub produced by merging the pull request, once merged. */
	readonly mergeCommit: string | null;
	/**
	 * When the artifacts of this run expire, as GitHub's retention settings
	 * say. §4 promises no history beyond this, so the run states it rather
	 * than letting a reader assume otherwise.
	 */
	readonly artifactsExpireAt: string | null;
}
