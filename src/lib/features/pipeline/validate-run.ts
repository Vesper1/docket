import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DocketError } from '../../shared/result/docket-error.ts';
import { ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { withWorkspace } from '../git/workspace.ts';
import { ARTIFACT_NAMES, writeRunArtifacts } from '../run/write-artifacts.ts';
import type { LogFile } from '../run/write-artifacts.ts';
import { RUN_SCHEMA } from '../run/run-record.ts';
import type { RunExecutor, RunRecord, RunTiming, RunWorkflow } from '../run/run-record.ts';
import { runDeployment } from '../salesforce/deploy.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import type { SalesforceCli } from '../salesforce/sf-cli.ts';
import type { StepRunOutcome } from '../steps/run-steps.ts';
import { validationRecordOf } from '../validation/validation-record.ts';
import type { StepResult } from '../validation/validation-record.ts';
import type { PreparedRun } from './prepare.ts';

/** What the gates and Salesforce produced, before it becomes a record. */
interface ExecutionOutcome {
	readonly steps: readonly StepResult[];
	readonly logs: readonly LogFile[];
	readonly deployment: DeploymentOutcome | null;
}

export interface ValidateRequest {
	readonly prepared: PreparedRun;
	/** The git repository the exact head commit is exported from. */
	readonly repositoryDirectory: string;
	/** Where the run's artifacts are written. */
	readonly outputDirectory: string;
	/** The Salesforce CLI, without a working directory: the workspace is it. */
	readonly cli: Omit<SalesforceCli, 'cwd'>;
	readonly waitMinutes: number;
	readonly executor: RunExecutor;
	readonly timing: RunTiming;
	/** Passing evidence produced before this process received org credentials. */
	readonly gates: StepRunOutcome;
	readonly workflow?: RunWorkflow;
	/** When GitHub will delete this run's artifacts, when that is knowable. */
	readonly artifactsExpireAt?: string;
	readonly signal?: AbortSignal;
}

/**
 * Phase C: gates first, then Salesforce, then the record.
 *
 * Everything runs in a workspace exported at the head commit, never in the
 * developer's checkout, so what the gates read and what Salesforce compiles is
 * exactly what the plan describes.
 */
export async function validateRun(request: ValidateRequest): Promise<Result<RunRecord, DocketError>> {
	const { plan } = request.prepared;
	const manifests = await writeManifests(request.outputDirectory, request.prepared);

	const outcome = await withWorkspace<ExecutionOutcome>(
		{ cwd: request.repositoryDirectory, sha: plan.plan.source.headSha },
		async (workspace) => {
			// The gates were run in a separate credential-free phase. Keep this
			// guard even though the artifact reader only admits a full pass: a direct
			// library caller must not be able to smuggle a failed gate into Salesforce.
			if (request.gates.results.some((step) => step.status !== 'passed')) {
				return ok({ steps: request.gates.results, logs: request.gates.logs, deployment: null });
			}

			const deployment = await runDeployment(
				{ ...request.cli, cwd: workspace.directory },
				'validate',
				{
					manifestPath: manifests.packageXml,
					destructivePath: manifests.destructiveChangesXml,
					org: plan.plan.target.org,
					tests: plan.plan.tests,
					waitMinutes: request.waitMinutes,
				},
			);
			if (!deployment.ok) return deployment;

			// Automatic pre-deployment hooks belong immediately before deployment,
			// not here. Running them here would execute them twice and, worse, would
			// expose validation credentials to candidate-controlled script bytes.
			const manual: StepResult[] = plan.plan.steps.preDeployment.flatMap((step) =>
				step.kind === 'manual'
					? [
							{
								name: step.name,
								kind: 'pre',
								manual: true,
								status: 'pending',
								exitCode: null,
								completedBy: null,
							} as const,
						]
					: [],
			);

			return ok({
				steps: [...request.gates.results, ...manual],
				logs: request.gates.logs,
				deployment: deployment.value,
			});
		},
	);
	if (!outcome.ok) return outcome;

	const validation = validationRecordOf({
		plan: plan.plan,
		steps: outcome.value.steps,
		deployment: outcome.value.deployment,
	});

	const run: RunRecord = {
		schema: RUN_SCHEMA,
		kind: 'validate',
		executor: request.executor,
		status: validation.verdict,
		timing: request.timing,
		plan: plan.plan,
		validation,
		deployment: null,
		steps: outcome.value.steps,
		workflow: request.workflow ?? null,
		mergeCommit: null,
		artifactsExpireAt: request.artifactsExpireAt ?? null,
	};

	const written = await writeRunArtifacts(request.outputDirectory, {
		plan,
		validation,
		run,
		logs: outcome.value.logs as readonly LogFile[],
	});
	if (!written.ok) return written;

	return ok(run);
}

/**
 * The manifests must exist as files before the CLI can be pointed at them,
 * and they are written into the run directory so the artifact the deployment
 * later verifies is the same file validation used.
 */
async function writeManifests(
	directory: string,
	prepared: PreparedRun,
): Promise<{ packageXml: string; destructiveChangesXml: string | undefined }> {
	await mkdir(directory, { recursive: true });

	const packageXml = join(directory, ARTIFACT_NAMES.packageXml);
	await writeFile(packageXml, prepared.plan.packageXml, 'utf8');

	if (prepared.plan.destructiveChangesXml === undefined) {
		return { packageXml, destructiveChangesXml: undefined };
	}

	const destructiveChangesXml = join(directory, ARTIFACT_NAMES.destructiveChangesXml);
	await writeFile(destructiveChangesXml, prepared.plan.destructiveChangesXml, 'utf8');

	return { packageXml, destructiveChangesXml };
}

export type { StepResult };
