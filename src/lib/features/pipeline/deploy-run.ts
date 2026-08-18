import { readFile } from 'node:fs/promises';

import { canonicalJson } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME } from '../config/docket-config.ts';
import type { EnvironmentConfig } from '../config/docket-config.ts';
import { parseConfig } from '../config/parse-config.ts';
import { selectEnvironment } from '../config/select-environment.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { withWorkspace } from '../git/workspace.ts';
import { renderReport } from '../plan/report.ts';
import { planChangesMetadata } from '../plan/deployment-plan.ts';
import type { DeploymentPlan } from '../plan/deployment-plan.ts';
import { readValidatedRun } from '../run/read-artifacts.ts';
import { RUN_SCHEMA } from '../run/run-record.ts';
import type { RunExecutor, RunRecord, RunTiming, RunWorkflow } from '../run/run-record.ts';
import { writeRunArtifacts } from '../run/write-artifacts.ts';
import type { LogFile } from '../run/write-artifacts.ts';
import { runDeployment } from '../salesforce/deploy.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import { requireOrgId, resolveOrg } from '../salesforce/org.ts';
import type { SalesforceCli } from '../salesforce/sf-cli.ts';
import { runSteps } from '../steps/run-steps.ts';
import { completedSteps, readCompletions } from '../steps/step-completion.ts';
import type { StepCompletion } from '../steps/step-completion.ts';
import type { StepResult, ValidationRecord } from '../validation/validation-record.ts';

/** What running the steps and the deployment produced, before it is recorded. */
interface ExecutionOutcome {
	readonly steps: readonly StepResult[];
	readonly logs: readonly LogFile[];
	readonly deployment: DeploymentOutcome | null;
}

export interface DeployRunRequest {
	/** Directory holding the artifacts of the validation run. */
	readonly validatedDirectory: string;
	/** The git repository the exact head commit is exported from. */
	readonly repositoryDirectory: string;
	/** Where this deployment's own artifacts are written. */
	readonly outputDirectory: string;
	/** Directory of manual-step completion records, when the plan has any. */
	readonly completionsDirectory?: string;
	readonly cli: Omit<SalesforceCli, 'cwd'>;
	readonly waitMinutes: number;
	readonly executor: RunExecutor;
	readonly timing: RunTiming;
	/** The commit GitHub produced by merging the pull request, when there is one. */
	readonly mergeCommit?: string;
	/**
	 * The head SHA GitHub reports right now. The validated plan must still be
	 * about that exact commit, or the pull request moved after its check went
	 * green and the plan no longer describes what was merged.
	 */
	readonly expectedHeadSha?: string;
	/** Identity read from the green check that selected these artifacts. */
	readonly expectedPlanIdentity?: string;
	readonly workflow?: RunWorkflow;
	/** When GitHub will delete this run's artifacts, when that is knowable. */
	readonly artifactsExpireAt?: string;
	/** A rollback deploys through this same path; only the label differs. */
	readonly kind?: 'deploy' | 'rollback';
	readonly signal?: AbortSignal;
}

/**
 * Phase D: deploy exactly what was validated, and nothing else.
 *
 * Everything is verified before a single Salesforce command is built — the
 * plan's own identity, the manifests on disk, the validation verdict, the
 * steps against the trusted configuration, the manual completions and the org
 * the alias currently points at. A mismatch stops the run here, which is why a
 * tampered artifact produces no deployment rather than a failed one.
 */
export async function deployRun(request: DeployRunRequest): Promise<Result<RunRecord, DocketError>> {
	const validated = await readValidatedRun(request.validatedDirectory);
	if (!validated.ok) return validated;

	const { plan, validation } = validated.value;
	if (
		request.expectedPlanIdentity !== undefined &&
		request.expectedPlanIdentity !== plan.identity
	) {
		return err(
			docketError(
				ErrorCode.planMismatch,
				`refusing to deploy: the green check approved ${request.expectedPlanIdentity}, but the downloaded plan is ${plan.identity}`,
			),
		);
	}

	if (request.expectedHeadSha !== undefined && request.expectedHeadSha !== plan.source.headSha) {
		return err(
			docketError(
				ErrorCode.planMismatch,
				`refusing to deploy: the validated plan is for ${plan.source.headSha}, but GitHub reports ${request.expectedHeadSha}`,
			),
		);
	}

	// The steps that will run with deployment credentials come from the base
	// commit, never from the artifacts, and the artifacts must agree (§4).
	const trusted = await trustedEnvironment(request.repositoryDirectory, plan);
	if (!trusted.ok) return trusted;

	const manual = await requireManualSteps(request, plan);
	if (!manual.ok) return manual;

	const org = await resolveOrg({ ...request.cli, cwd: request.repositoryDirectory }, plan.target.org);
	if (!org.ok) return org;

	const expected = requireOrgId(org.value, plan.target.orgId);
	if (!expected.ok) return expected;

	const completed = new Set(manual.value.keys());
	const completedBy = new Map(
		[...manual.value].map(([name, completion]) => [name, completion.completedBy]),
	);

	const executed = await withWorkspace<ExecutionOutcome>(
		{ cwd: request.repositoryDirectory, sha: plan.source.headSha },
		(candidateWorkspace) =>
			withWorkspace<ExecutionOutcome>(
				// Privileged hook bytes come from the trusted base tree. A pull
				// request may change the same script at head, but those bytes are
				// never executed with deployment credentials.
				{ cwd: request.repositoryDirectory, sha: plan.source.baseSha },
				async (trustedWorkspace) => {
					const before = await runSteps(trusted.value.preDeployment, {
						cwd: trustedWorkspace.directory,
						kind: 'pre',
						withoutCredentials: false,
						completed,
						completedBy,
						...(request.signal === undefined ? {} : { signal: request.signal }),
					});

					// A failed pre-deployment hook stops the run before the org changes.
					if (before.results.some((step) => step.status === 'failed')) {
						return ok({ steps: before.results, logs: before.logs, deployment: null });
					}

					// The validated plan asked Salesforce for nothing, so neither does
					// the deployment. The steps around it still run and are recorded.
					const deployment = planChangesMetadata(plan)
						? await runDeployment(
						{ ...request.cli, cwd: candidateWorkspace.directory },
						'deploy',
						{
							manifestPath: validated.value.packageXmlPath,
							destructivePath: validated.value.destructiveChangesXmlPath,
							org: plan.target.org,
							tests: plan.tests,
							waitMinutes: request.waitMinutes,
						},
						)
						: ok(null);
					if (!deployment.ok) return deployment;

					// §5 Phase E.1: post-deployment steps run whatever the deployment
					// did, because a failed deployment also has to be cleaned up after.
					const after = await runSteps(trusted.value.postDeployment, {
						cwd: trustedWorkspace.directory,
						kind: 'post',
						withoutCredentials: false,
						completed,
						completedBy,
						...(request.signal === undefined ? {} : { signal: request.signal }),
					});

					return ok({
						steps: [...before.results, ...after.results],
						logs: [...before.logs, ...after.logs],
						deployment: deployment.value,
					});
				},
			),
	);
	if (!executed.ok) return executed;

	const run = recordOf(request, plan, validation, executed.value.steps, executed.value.deployment);

	const written = await writeRunArtifacts(request.outputDirectory, {
		plan: {
			plan,
			packageXml: await readFile(validated.value.packageXmlPath, 'utf8'),
			destructiveChangesXml:
				validated.value.destructiveChangesXmlPath === undefined
					? undefined
					: await readFile(validated.value.destructiveChangesXmlPath, 'utf8'),
			report: renderReport(plan),
		},
		validation,
		run,
		logs: executed.value.logs as readonly LogFile[],
	});
	if (!written.ok) return written;

	return ok(run);
}

function recordOf(
	request: DeployRunRequest,
	plan: DeploymentPlan,
	validation: ValidationRecord,
	steps: readonly StepResult[],
	deployment: DeploymentOutcome | null,
): RunRecord {
	// A plan with no components deploys nothing, so a missing Salesforce answer
	// is the expected one. For every other plan it is still a failure.
	const missingAnswer = planChangesMetadata(plan) && deployment === null;
	const failed =
		missingAnswer ||
		(deployment !== null && !deployment.success) ||
		steps.some((step) => step.status === 'failed');

	return {
		schema: RUN_SCHEMA,
		kind: request.kind ?? 'deploy',
		executor: request.executor,
		status: failed ? 'failed' : 'passed',
		timing: request.timing,
		plan,
		validation,
		deployment,
		steps,
		workflow: request.workflow ?? null,
		mergeCommit: request.mergeCommit ?? null,
		artifactsExpireAt: request.artifactsExpireAt ?? null,
	};
}

/**
 * Re-reads `docket.yml` from the base commit and requires it to still describe
 * the steps the plan was validated with.
 *
 * Without this the steps would effectively come from an artifact, and an
 * artifact is input: whoever could edit one would be choosing which commands
 * run with deployment credentials.
 */
async function trustedEnvironment(
	repositoryDirectory: string,
	plan: DeploymentPlan,
): Promise<Result<EnvironmentConfig, DocketError>> {
	const text = await readFileAtCommit({
		cwd: repositoryDirectory,
		sha: plan.source.baseSha,
		path: CONFIG_FILE_NAME,
	});
	if (!text.ok) return text;

	const config = parseConfig(text.value);
	if (!config.ok) return config;

	const environment = selectEnvironment(config.value, plan.target.environmentId);
	if (!environment.ok) return environment;

	const recorded = canonicalJson(plan.steps);
	const current = canonicalJson({
		gates: environment.value.gates,
		preDeployment: environment.value.preDeployment,
		postDeployment: environment.value.postDeployment,
	});

	if (recorded !== current) {
		return err(
			docketError(
				ErrorCode.planMismatch,
				'refusing to deploy: the configured steps are not the ones this plan was validated with',
			),
		);
	}

	return environment;
}

/** Every manual pre-deployment step must be recorded as done for this plan. */
async function requireManualSteps(
	request: DeployRunRequest,
	plan: DeploymentPlan,
): Promise<Result<ReadonlyMap<string, StepCompletion>, DocketError>> {
	const required = plan.steps.preDeployment.filter((step) => step.kind === 'manual');
	if (required.length === 0) return ok(new Map());

	const completions =
		request.completionsDirectory === undefined
			? ok<readonly StepCompletion[]>([])
			: await readCompletions(request.completionsDirectory);
	if (!completions.ok) return completions;

	const done = completedSteps(completions.value, plan.identity, plan.source.headSha);
	const missing = required.filter((step) => !done.has(step.name));
	if (missing.length > 0) {
		return err(
			docketError(
				ErrorCode.stepIncomplete,
				`refusing to deploy: manual steps not completed: ${missing.map((step) => step.name).join(', ')}`,
			),
		);
	}

	return ok(done);
}
