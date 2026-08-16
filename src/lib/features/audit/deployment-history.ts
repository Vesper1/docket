import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, canonicalJsonFile, digestOf } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { readRecordedRun } from '../run/read-artifacts.ts';
import type { RunRecord } from '../run/run-record.ts';
import { findSecrets } from '../run/secret-scan.ts';

export const DEPLOYMENT_HISTORY_SCHEMA = 'docket.deployment-history/v1';

export interface DeploymentHistoryEntry {
	readonly id: string;
	readonly kind: 'deploy' | 'rollback';
	readonly status: 'passed' | 'failed';
	readonly repository: string;
	readonly pullRequest: number;
	readonly baseSha: string;
	readonly headSha: string;
	readonly mergeCommit: string | null;
	readonly environment: {
		readonly id: string;
		readonly org: string;
		readonly orgId: string;
	};
	readonly planIdentity: string;
	readonly validation: {
		readonly verdict: 'passed' | 'failed';
		readonly deploymentId: string | null;
		readonly status: string | null;
	};
	readonly deployment: {
		readonly deploymentId: string;
		readonly status: string;
		readonly success: boolean;
	} | null;
	readonly components: {
		readonly deployable: number;
		readonly destructive: number;
	};
	readonly steps: readonly {
		readonly name: string;
		readonly kind: 'gate' | 'pre' | 'post';
		readonly status: 'passed' | 'failed' | 'skipped' | 'pending';
		readonly manual: boolean;
		readonly completedBy: string | null;
	}[];
	readonly workflow: { readonly runId: string; readonly runAttempt: number } | null;
	readonly timing: { readonly startedAt: string; readonly finishedAt: string };
	readonly artifactsExpireAt: string | null;
}

export interface DeploymentHistory {
	readonly schema: typeof DEPLOYMENT_HISTORY_SCHEMA;
	readonly entries: readonly DeploymentHistoryEntry[];
	readonly retention: {
		readonly boundedByArtifacts: true;
		readonly earliestKnownExpiry: string | null;
		readonly unknownExpiryEntries: number;
	};
}

export const HISTORY_ARTIFACT_NAMES = {
	json: 'history.json',
	report: 'history.md',
} as const;

/** M12.3: rebuilds a deterministic deployment ledger from verified run bundles. */
export async function buildDeploymentHistory(
	root: string,
): Promise<Result<DeploymentHistory, DocketError>> {
	const directories = await discoverRunDirectories(root);
	if (!directories.ok) return directories;
	if (directories.value.length === 0) {
		return err(invalid(`no run.json artifacts were found below ${root}`));
	}

	const byId = new Map<string, DeploymentHistoryEntry>();
	for (const directory of directories.value) {
		const recorded = await readRecordedRun(directory);
		if (!recorded.ok) {
			return err(invalid(`invalid run bundle below ${root}: ${recorded.error.message}`));
		}
		const run = recorded.value.run;
		if (run.kind === 'validate') continue;

		const entry = historyEntry(run, run.kind);
		const existing = byId.get(entry.id);
		if (existing !== undefined && canonicalJson(existing) !== canonicalJson(entry)) {
			return err(invalid(`two run bundles claim history id ${entry.id} with different contents`));
		}
		byId.set(entry.id, entry);
	}

	const entries = [...byId.values()].sort((left, right) => {
		if (left.timing.finishedAt !== right.timing.finishedAt) {
			return left.timing.finishedAt > right.timing.finishedAt ? -1 : 1;
		}
		return compareText(left.id, right.id);
	});
	if (entries.length === 0) {
		return err(invalid('the supplied artifacts contain validation runs but no deployment runs'));
	}

	const knownExpiries = entries
		.map((entry) => entry.artifactsExpireAt)
		.filter((value): value is string => value !== null)
		.sort(compareText);

	return ok({
		schema: DEPLOYMENT_HISTORY_SCHEMA,
		entries,
		retention: {
			boundedByArtifacts: true,
			earliestKnownExpiry: knownExpiries[0] ?? null,
			unknownExpiryEntries: entries.filter((entry) => entry.artifactsExpireAt === null).length,
		},
	});
}

export async function writeDeploymentHistory(
	directory: string,
	history: DeploymentHistory,
): Promise<Result<readonly string[], DocketError>> {
	const files = new Map<string, string>([
		[HISTORY_ARTIFACT_NAMES.json, canonicalJsonFile(history)],
		[HISTORY_ARTIFACT_NAMES.report, renderDeploymentHistory(history)],
	]);

	for (const [name, contents] of files) {
		const finding = findSecrets(contents)[0];
		if (finding !== undefined) {
			return err(
				docketError(
					ErrorCode.secretInArtifact,
					`refusing to write ${name}: it contains a ${finding.rule} on line ${finding.line}`,
				),
			);
		}
	}

	await mkdir(directory, { recursive: true });
	for (const [name, contents] of files) await writeFile(join(directory, name), contents, 'utf8');
	return ok([...files.keys()].sort(compareText));
}

export function renderDeploymentHistory(history: DeploymentHistory): string {
	const lines = [
		'# Docket deployment history',
		'',
		'| Finished | Result | PR | Head | Org | Validation | Deployment | Workflow |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |',
		...history.entries.map(
			(entry) =>
				`| ${[
					entry.timing.finishedAt,
					`${entry.kind}/${entry.status}`,
					`#${entry.pullRequest}`,
					`\`${entry.headSha}\``,
					`\`${entry.environment.orgId}\``,
					entry.validation.deploymentId === null
						? entry.validation.verdict
						: `\`${entry.validation.deploymentId}\` ${entry.validation.verdict}`,
					entry.deployment === null
						? 'not started'
						: `\`${entry.deployment.deploymentId}\` ${entry.deployment.status}`,
					entry.workflow === null ? 'local' : `${entry.workflow.runId}/${entry.workflow.runAttempt}`,
				].join(' | ')} |`,
		),
		'',
		`History is bounded by retained run artifacts. Unknown expiry: ${history.retention.unknownExpiryEntries}; earliest known expiry: ${history.retention.earliestKnownExpiry ?? 'unknown'}.`,
		'',
	];

	return lines.join('\n');
}

function historyEntry(
	run: RunRecord,
	kind: 'deploy' | 'rollback',
): DeploymentHistoryEntry {
	const key =
		run.workflow === null
			? digestOf(
					canonicalJson({
						kind,
						planIdentity: run.plan.identity,
						startedAt: run.timing.startedAt,
						deploymentId: run.deployment?.deploymentId ?? null,
					}),
				)
			: `${run.plan.source.repository}:${run.workflow.runId}/${run.workflow.runAttempt}`;

	return {
		id: `${run.executor}:${key}`,
		kind,
		status: run.status,
		repository: run.plan.source.repository,
		pullRequest: run.plan.source.pullRequest,
		baseSha: run.plan.source.baseSha,
		headSha: run.plan.source.headSha,
		mergeCommit: run.mergeCommit,
		environment: {
			id: run.plan.target.environmentId,
			org: run.plan.target.org,
			orgId: run.plan.target.orgId,
		},
		planIdentity: run.plan.identity,
		validation: {
			verdict: run.validation?.verdict ?? 'failed',
			deploymentId: run.validation?.deployment?.deploymentId ?? null,
			status: run.validation?.deployment?.status ?? null,
		},
		deployment:
			run.deployment === null
				? null
				: {
						deploymentId: run.deployment.deploymentId,
						status: run.deployment.status,
						success: run.deployment.success,
					},
		components: {
			deployable: run.plan.components.deployable.length,
			destructive: run.plan.components.destructive.length,
		},
		steps: run.steps.map((step) => ({
			name: step.name,
			kind: step.kind,
			status: step.status,
			manual: step.manual,
			completedBy: step.completedBy,
		})),
		workflow: run.workflow,
		timing: run.timing,
		artifactsExpireAt: run.artifactsExpireAt,
	};
}

async function discoverRunDirectories(root: string): Promise<Result<readonly string[], DocketError>> {
	const found: string[] = [];

	async function visit(directory: string): Promise<Result<void, DocketError>> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return err(invalid(`cannot read ${directory}: ${detail}`));
		}

		if (entries.some((entry) => entry.isFile() && entry.name === 'run.json')) {
			found.push(directory);
			return ok(undefined);
		}

		for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
			// Never follow symlinks out of the caller's chosen artifact root.
			if (!entry.isDirectory()) continue;
			const nested = await visit(join(directory, entry.name));
			if (!nested.ok) return nested;
		}
		return ok(undefined);
	}

	const visited = await visit(root);
	return visited.ok ? ok(found.sort(compareText)) : visited;
}

function invalid(problem: string): DocketError {
	return docketError(ErrorCode.historyInvalid, `cannot build deployment history: ${problem}`);
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}
