import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DocketError } from '../../shared/result/docket-error.ts';
import { ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME, parseConfig } from '../config/config.ts';
import type { DocketConfig } from '../config/config.ts';
import { runGates } from '../gates/run-gates.ts';
import type { GateResult } from '../gates/run-gates.ts';
import { readChanges } from '../git/read-changes.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { withWorkspace } from '../git/workspace.ts';
import { buildPlan, planChangesMetadata, renderReport } from '../plan/plan.ts';
import type { DeploymentPlan } from '../plan/plan.ts';
import { runDeployment } from '../salesforce/deploy.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';

/** File names inside the output directory. */
export const ARTIFACT_NAMES = {
	packageXml: 'package.xml',
	destructiveChangesXml: 'destructiveChanges.xml',
	report: 'report.md',
	result: 'result.json',
} as const;

export interface PipelineRequest {
	readonly kind: 'deploy' | 'rollback';
	/** The git repository both commits already exist in. */
	readonly repositoryDirectory: string;
	readonly baseSha: string;
	readonly headSha: string;
	readonly outputDirectory: string;
	readonly executable: string;
	readonly waitMinutes: number;
	/** Ask Salesforce to check the deployment without changing the org. */
	readonly checkOnly: boolean;
	readonly signal?: AbortSignal;
}

export interface RunOutcome {
	readonly kind: 'deploy' | 'rollback';
	readonly status: 'passed' | 'failed';
	readonly plan: DeploymentPlan;
	readonly gates: readonly GateResult[];
	readonly deployment: DeploymentOutcome | null;
	/** Why the run failed, in the order the reasons were found. */
	readonly failures: readonly string[];
	readonly directory: string;
}

/**
 * One run, start to finish: plan, gates, Salesforce, artifacts.
 *
 * Everything executes in a workspace exported at the exact source commit, never
 * in the caller's checkout, so what the gates read and what Salesforce compiles
 * is exactly what the plan describes.
 */
export const runPipeline = async (request: PipelineRequest): Promise<Result<RunOutcome, DocketError>> => {
	const prepared = await preparePlan(request);
	if (!prepared.ok) return prepared;
	const { config, plan } = prepared.value;

	const manifests = await writeManifests(request.outputDirectory, plan);
	await write(join(request.outputDirectory, ARTIFACT_NAMES.report), renderReport(plan));

	const executed = await withWorkspace<{
		gates: readonly GateResult[];
		deployment: DeploymentOutcome | null;
	}>({ cwd: request.repositoryDirectory, sha: plan.sourceSha }, async (workspace) => {
		const gates = await runGates(config.gates, {
			cwd: workspace.directory,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});

		for (const gate of gates.results) {
			if (gate.log === '') continue;
			await write(join(request.outputDirectory, 'logs', `gate-${gate.name}.log`), gate.log);
		}

		// A failed gate is the answer: Salesforce is never asked anything.
		if (!gates.passed) return ok({ gates: gates.results, deployment: null });

		// Salesforce refuses an empty request, and a change that touches no
		// metadata is legitimately nothing to deploy.
		if (!planChangesMetadata(plan)) return ok({ gates: gates.results, deployment: null });

		const deployment = await runDeployment(
			{
				executable: request.executable,
				cwd: workspace.directory,
				timeoutMs: (request.waitMinutes + GRACE_MINUTES) * 60_000,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			},
			request.checkOnly ? 'validate' : 'deploy',
			{
				manifestPath: manifests.packageXml,
				destructivePath: manifests.destructiveChangesXml,
				org: plan.org,
				tests: plan.tests,
				waitMinutes: request.waitMinutes,
			},
		);
		if (!deployment.ok) return deployment;

		return ok({ gates: gates.results, deployment: deployment.value });
	});
	if (!executed.ok) return executed;

	const failures = failuresOf(executed.value.gates, executed.value.deployment);
	const outcome: RunOutcome = {
		kind: request.kind,
		status: failures.length === 0 ? 'passed' : 'failed',
		plan,
		gates: executed.value.gates,
		deployment: executed.value.deployment,
		failures,
		directory: request.outputDirectory,
	};

	await write(
		join(request.outputDirectory, ARTIFACT_NAMES.result),
		`${JSON.stringify(resultDocument(outcome), null, '\t')}\n`,
	);

	return ok(outcome);
};

/** How long past the CLI's own wait the process is allowed to live. */
const GRACE_MINUTES = 5;

export interface PreparedPlan {
	readonly config: DocketConfig;
	readonly plan: DeploymentPlan;
}

/**
 * Everything a run decides before it touches anything: trusted configuration,
 * the exact diff, and the manifests that follow from them.
 *
 * Exported so `docket plan` can show exactly what `docket deploy` would do,
 * without a second implementation to drift apart from it.
 */
export const preparePlan = async (
	request: Pick<PipelineRequest, 'kind' | 'repositoryDirectory' | 'baseSha' | 'headSha'>,
): Promise<Result<PreparedPlan, DocketError>> => {
	const config = await trustedConfig(request);
	if (!config.ok) return config;

	const changes = await readChanges({
		cwd: request.repositoryDirectory,
		baseSha: request.baseSha,
		headSha: request.headSha,
	});
	if (!changes.ok) return changes;

	const plan = buildPlan({
		kind: request.kind,
		changes: changes.value,
		config: config.value,
		baseSha: request.baseSha,
		headSha: request.headSha,
	});

	return plan.ok ? ok({ config: config.value, plan: plan.value }) : plan;
};

/**
 * Configuration comes from the base commit, never the working tree: a candidate
 * change must not be able to rewrite the gate commands that run beside a
 * deployment credential, nor repoint the org.
 */
const trustedConfig = async (
	request: Pick<PipelineRequest, 'repositoryDirectory' | 'baseSha'>,
): Promise<Result<DocketConfig, DocketError>> => {
	const text = await readFileAtCommit({
		cwd: request.repositoryDirectory,
		sha: request.baseSha,
		path: CONFIG_FILE_NAME,
	});

	return text.ok ? parseConfig(text.value) : text;
};

const failuresOf = (
	gates: readonly GateResult[],
	deployment: DeploymentOutcome | null,
): readonly string[] => {
	const failures: string[] = [];

	for (const gate of gates) {
		if (gate.status === 'failed') failures.push(`gate \`${gate.name}\` failed`);
	}

	if (deployment === null) return failures;
	if (!deployment.success) failures.push(`Salesforce reported ${deployment.status}`);
	for (const failure of deployment.componentFailures) {
		failures.push(`${failure.type} ${failure.member}: ${failure.problem}`);
	}
	for (const failure of deployment.tests.failures) {
		failures.push(`${failure.className}.${failure.method}: ${failure.message}`);
	}

	return failures;
};

/** The record on disk. Deliberately not the in-memory shape: no manifest bytes. */
const resultDocument = (outcome: RunOutcome) => ({
	kind: outcome.kind,
	status: outcome.status,
	base: outcome.plan.baseSha,
	head: outcome.plan.headSha,
	source: outcome.plan.sourceSha,
	org: outcome.plan.org,
	tests: outcome.plan.tests,
	components: outcome.plan.components,
	gates: outcome.gates.map((gate) => ({
		name: gate.name,
		status: gate.status,
		exitCode: gate.exitCode,
	})),
	deployment: outcome.deployment,
	failures: outcome.failures,
});

const writeManifests = async (
	directory: string,
	plan: DeploymentPlan,
): Promise<{ packageXml: string; destructiveChangesXml: string | undefined }> => {
	const packageXml = join(directory, ARTIFACT_NAMES.packageXml);
	await write(packageXml, plan.packageXml);

	if (plan.destructiveChangesXml === null) {
		return { packageXml, destructiveChangesXml: undefined };
	}

	const destructiveChangesXml = join(directory, ARTIFACT_NAMES.destructiveChangesXml);
	await write(destructiveChangesXml, plan.destructiveChangesXml);

	return { packageXml, destructiveChangesXml };
};

const write = async (path: string, contents: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, 'utf8');
};
