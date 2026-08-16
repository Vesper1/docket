import type { FileChange } from '../git/file-change.ts';
import type {
	OriginatingRun,
	PublishedCheck,
	StepCompletionOrigin,
} from '../github/checks.ts';
import type { GateRunRecord } from '../pipeline/gate-run.ts';
import type { StepCompletion } from '../steps/step-completion.ts';
import type { DeploymentPlan } from '../plan/deployment-plan.ts';
import type { RunRecord } from '../run/run-record.ts';
import type { CompensatingPullRequest } from '../github/rollback-pull-request.ts';
import type { RollbackPlan } from '../rollback/rollback-plan.ts';
import type { DeploymentHistory } from '../audit/deployment-history.ts';
import { renderDeploymentHistory } from '../audit/deployment-history.ts';
import type { StateAudit } from '../audit/state-contract.ts';
import { renderStateAudit } from '../audit/state-contract.ts';
import { PRODUCT_NAME } from '../../shared/meta/meta.ts';
import type { DocketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { Result } from '../../shared/result/result.ts';
import { ExitCode } from './exit-code.ts';

export type OutputFormat = 'text' | 'json';

/** Everything a command can hand back, before it is turned into bytes. */
export type CliData =
	| { readonly kind: 'help'; readonly usage: string }
	| { readonly kind: 'version'; readonly name: string; readonly version: string }
	| { readonly kind: 'changes'; readonly changes: readonly FileChange[] }
	| { readonly kind: 'plan'; readonly plan: DeploymentPlan; readonly report: string }
	| { readonly kind: 'gate-run'; readonly run: GateRunRecord; readonly directory: string }
	| { readonly kind: 'run'; readonly run: RunRecord; readonly directory: string }
	| { readonly kind: 'recorded-run'; readonly run: RunRecord; readonly directory: string }
	| { readonly kind: 'check'; readonly check: PublishedCheck }
	| { readonly kind: 'originating-run'; readonly originating: OriginatingRun }
	| { readonly kind: 'step-origins'; readonly origins: readonly StepCompletionOrigin[] }
	| { readonly kind: 'step-completed'; readonly completion: StepCompletion; readonly path: string }
	| { readonly kind: 'rollback-source'; readonly run: RunRecord; readonly directory: string }
	| {
			readonly kind: 'rollback-plan';
			readonly plan: RollbackPlan;
			readonly report: string;
			readonly directory: string | null;
	  }
	| {
			readonly kind: 'rollback-pr';
			readonly pullRequest: CompensatingPullRequest;
			readonly plan: RollbackPlan;
			readonly directory: string | null;
	  }
	| {
			readonly kind: 'history';
			readonly history: DeploymentHistory;
			readonly directory: string | null;
	  }
	| { readonly kind: 'state-audit'; readonly audit: StateAudit };

export interface CliOutcome {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: ExitCode;
}

/**
 * Which exit code each failure deserves. Exhaustive by type: adding an
 * ErrorCode without deciding its exit code is a compile error, not a surprise
 * exit 0 in someone's pipeline.
 */
const EXIT_BY_ERROR_CODE: Record<ErrorCode, ExitCode> = {
	unknown_command: ExitCode.usage,
	invalid_option: ExitCode.usage,
	missing_option: ExitCode.usage,
	// The rest describe a subject Docket was asked about, not a mistyped
	// invocation: the run started and the answer is that it cannot proceed.
	git_failed: ExitCode.failure,
	unsupported_change: ExitCode.failure,
	unsupported_metadata: ExitCode.failure,
	invalid_config: ExitCode.failure,
	unknown_environment: ExitCode.usage,
	branch_mismatch: ExitCode.failure,
	destructive_not_allowed: ExitCode.failure,
	salesforce_failed: ExitCode.failure,
	org_unavailable: ExitCode.failure,
	org_mismatch: ExitCode.failure,
	secret_in_artifact: ExitCode.failure,
	plan_mismatch: ExitCode.failure,
	validation_not_passed: ExitCode.failure,
	github_failed: ExitCode.failure,
	pull_request_not_eligible: ExitCode.failure,
	step_incomplete: ExitCode.failure,
	step_already_completed: ExitCode.failure,
	rollback_source_invalid: ExitCode.failure,
	rollback_conflict: ExitCode.failure,
	history_invalid: ExitCode.failure,
};

export function render(result: Result<CliData, DocketError>, format: OutputFormat): CliOutcome {
	return format === 'json' ? renderJson(result) : renderText(result);
}

/**
 * A run that completed but did not pass exits non-zero.
 *
 * The command worked; its subject failed. Nothing downstream — a shell, a
 * workflow step, a required check — may read that as success.
 */
function exitCodeOf(data: CliData): ExitCode {
	return (data.kind === 'run' || data.kind === 'gate-run') && data.run.status === 'failed'
		? ExitCode.failure
		: ExitCode.success;
}

/**
 * In JSON mode everything goes to stdout, successes and failures alike, so
 * `docket … --json | jq` keeps working on a failing run. The exit code, not
 * the stream, carries the verdict.
 */
function renderJson(result: Result<CliData, DocketError>): CliOutcome {
	if (result.ok) {
		return {
			stdout: encode({ ok: true, data: result.value }),
			stderr: '',
			exitCode: exitCodeOf(result.value),
		};
	}

	const { code, message } = result.error;
	return {
		stdout: encode({ ok: false, error: { code, message } }),
		stderr: '',
		exitCode: EXIT_BY_ERROR_CODE[code],
	};
}

function renderText(result: Result<CliData, DocketError>): CliOutcome {
	if (result.ok) {
		return { stdout: humanText(result.value), stderr: '', exitCode: exitCodeOf(result.value) };
	}

	return {
		stdout: '',
		stderr: `${PRODUCT_NAME}: ${result.error.message}\nRun \`${PRODUCT_NAME} --help\` for usage.\n`,
		exitCode: EXIT_BY_ERROR_CODE[result.error.code],
	};
}

function humanText(data: CliData): string {
	switch (data.kind) {
		case 'help':
			return data.usage;
		case 'version':
			return `${data.version}\n`;
		case 'changes':
			return changeLines(data.changes);
		case 'plan':
			return data.report;
		case 'gate-run':
			return `gates ${data.run.status}: ${data.run.source.repository} #${data.run.source.pullRequest}\nartifacts  ${data.directory}\n`;
		case 'run':
			return runSummary(data);
		case 'recorded-run':
			return runSummary(data);
		case 'check':
			return `${data.check.name} ${data.check.conclusion} for ${data.check.headSha}\n`;
		case 'originating-run':
			return `${data.originating.workflowRunId}\n`;
		case 'step-origins':
			return data.origins.map((origin) => `${origin.workflowRunId}\n`).join('');
		case 'step-completed':
			return `${data.completion.step} completed by ${data.completion.completedBy}\n${data.path}\n`;
		case 'rollback-source':
			return `rollback source ${data.run.deployment?.deploymentId ?? 'unknown'}\n${data.directory}\n`;
		case 'rollback-plan':
			return `${data.report}${data.directory === null ? '' : `artifacts  ${data.directory}\n`}`;
		case 'rollback-pr':
			return `rollback PR #${data.pullRequest.number}: ${data.pullRequest.url}\nbranch     ${data.pullRequest.branch}\n${data.directory === null ? '' : `artifacts  ${data.directory}\n`}`;
		case 'history':
			return `${renderDeploymentHistory(data.history)}${data.directory === null ? '' : `artifacts  ${data.directory}\n`}`;
		case 'state-audit':
			return renderStateAudit(data.audit);
	}
}

/** One change per line, status first, so `grep deleted` is a useful review. */
function changeLines(changes: readonly FileChange[]): string {
	if (changes.length === 0) return 'No changes between the two commits.\n';

	return changes
		.map((change) =>
			change.status === 'renamed'
				? `renamed  ${change.previousPath} -> ${change.path}\n`
				: `${change.status.padEnd(8)} ${change.path}\n`,
		)
		.join('');
}

/**
 * The verdict first, then the reasons. Someone reading a failed run in a
 * terminal needs the failures, not the plan they already approved.
 */
function runSummary(data: { readonly run: RunRecord; readonly directory: string }): string {
	const { run } = data;
	const lines = [
		`${run.kind} ${run.status}: ${run.plan.source.repository} #${run.plan.source.pullRequest} -> ${run.plan.target.environmentId}`,
		`head       ${run.plan.source.headSha}`,
		`org        ${run.plan.target.org} (${run.plan.target.orgId})`,
	];

	if (run.deployment !== null) lines.push(`salesforce ${run.deployment.deploymentId}`);
	for (const failure of run.validation?.failures ?? []) lines.push(`failed     ${failure}`);
	lines.push(`artifacts  ${data.directory}`);

	return `${lines.join('\n')}\n`;
}

/**
 * Deterministic by construction: key order comes from the object literals
 * above, and no value is a clock, a path or a random id. Two identical
 * invocations must produce identical bytes.
 */
function encode(payload: unknown): string {
	return `${JSON.stringify(payload)}\n`;
}
