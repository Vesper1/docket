import type { TestSelection } from '../config/docket-config.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import type { DeploymentPlan } from '../plan/deployment-plan.ts';

export const VALIDATION_SCHEMA = 'docket.validation/v1';

export type Verdict = 'passed' | 'failed';

/**
 * The result of one quality gate or hook, recorded whatever it decided.
 *
 * A gate that passes is evidence too: after a bad deployment, the question is
 * always which checks actually ran.
 */
export interface StepResult {
	readonly name: string;
	/** When in the run it happened. */
	readonly kind: 'gate' | 'pre' | 'post';
	/** Whether a person, rather than Docket, is what carries it out. */
	readonly manual: boolean;
	/**
	 * `pending` belongs to a manual step nobody has completed yet. It is not a
	 * failure — the run simply has not finished — but it is not a pass either,
	 * and the merge stays blocked while it stands.
	 */
	readonly status: Verdict | 'skipped' | 'pending';
	readonly exitCode: number | null;
	/** Who completed a manual step. Never set for automatic ones. */
	readonly completedBy: string | null;
}

/**
 * What validation decided, and the exact plan it decided about.
 *
 * `planIdentity` is the whole point of the record: a green check that does not
 * name what it approved cannot gate a merge, because the pull request could
 * have moved underneath it.
 */
export interface ValidationRecord {
	readonly schema: typeof VALIDATION_SCHEMA;
	readonly verdict: Verdict;
	readonly planIdentity: string;
	readonly org: { readonly reference: string; readonly id: string };
	readonly tests: TestSelection;
	readonly steps: readonly StepResult[];
	/**
	 * Whether Salesforce was asked at all. `not-required` belongs to a plan
	 * with no components: Salesforce rejects an empty request, so a pull
	 * request that changes no metadata is validated without it. It is recorded
	 * rather than inferred, so a later reader never has to guess why a passing
	 * record carries no deployment.
	 */
	readonly salesforce: 'validated' | 'not-required';
	/** Absent when validation failed before Salesforce was ever asked. */
	readonly deployment: DeploymentOutcome | null;
	/** Human-readable reasons, in the order they were found. */
	readonly failures: readonly string[];
}

export interface ValidationInput {
	readonly plan: DeploymentPlan;
	readonly steps: readonly StepResult[];
	readonly deployment: DeploymentOutcome | null;
	/** Defaults to `validated`: omitting it never excuses a missing answer. */
	readonly salesforce?: 'validated' | 'not-required';
	/** Reasons validation failed before Salesforce ran, if any. */
	readonly failures?: readonly string[];
}

/**
 * Builds the validation record and its verdict from what actually happened.
 *
 * Every listed failure mode of §5 Phase C.5 lands here: a failed gate, a CLI
 * error and a failed test are one verdict, because a merge must be blocked by
 * any of them.
 */
export const validationRecordOf = (input: ValidationInput): ValidationRecord => {
	const failures = [...(input.failures ?? [])];

	for (const step of input.steps) {
		if (step.status === 'failed') failures.push(`step \`${step.name}\` failed`);
	}

	const deployment = input.deployment;
	if (deployment !== null && !deployment.success) {
		failures.push(`Salesforce reported ${deployment.status}`);
		for (const failure of deployment.componentFailures) {
			failures.push(`${failure.type} ${failure.member}: ${failure.problem}`);
		}
		for (const failure of deployment.tests.failures) {
			failures.push(`${failure.className}.${failure.method}: ${failure.message}`);
		}
	}

	const salesforce = input.salesforce ?? 'validated';

	// No Salesforce answer at all is a failure, never a pass by omission —
	// unless the plan had nothing to ask about, which is stated, not assumed.
	if (salesforce === 'validated' && deployment === null && failures.length === 0) {
		failures.push('Salesforce validation did not run');
	}

	return {
		schema: VALIDATION_SCHEMA,
		verdict: failures.length === 0 ? 'passed' : 'failed',
		planIdentity: input.plan.identity,
		org: { reference: input.plan.target.org, id: input.plan.target.orgId },
		tests: input.plan.tests,
		steps: input.steps,
		salesforce,
		deployment,
		failures,
	};
};
