import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, canonicalJsonFile, digestOf } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME } from '../config/docket-config.ts';
import type { DocketConfig, EnvironmentConfig } from '../config/docket-config.ts';
import { parseConfig } from '../config/parse-config.ts';
import { selectEnvironment } from '../config/select-environment.ts';
import type { FileChange } from '../git/file-change.ts';
import { parseCommitSha } from '../git/commit-sha.ts';
import { readChanges } from '../git/read-changes.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { listPathsAtCommit, readPathAtCommit } from '../git/tree.ts';
import type { GitFileMode, GitPathState } from '../git/tree.ts';
import { classifyPath } from '../metadata/classify-path.ts';
import { collectComponents } from '../metadata/component-set.ts';
import type { ComponentSet, PlannedComponent } from '../metadata/component-set.ts';
import { compareComponents, componentKey } from '../metadata/metadata-component.ts';
import { renderPackageXml } from '../metadata/package-xml.ts';
import { buildPlan } from '../plan/build-plan.ts';
import type { RunRecord } from '../run/run-record.ts';
import { findSecrets } from '../run/secret-scan.ts';

export const ROLLBACK_PLAN_SCHEMA = 'docket.rollback-plan/v1';

export type RollbackOperation =
	| {
			readonly kind: 'delete';
			readonly path: string;
			readonly change: 'deleted';
			readonly contentDigest: null;
			readonly mode: null;
	  }
	| {
			readonly kind: 'write';
			readonly path: string;
			readonly change: 'added' | 'modified';
			readonly contentDigest: string;
			readonly mode: GitFileMode;
	  };

export interface RollbackPlan {
	readonly schema: typeof ROLLBACK_PLAN_SCHEMA;
	readonly source: {
		readonly repository: string;
		readonly pullRequest: number;
		readonly baseSha: string;
		readonly headSha: string;
		readonly planIdentity: string;
		readonly deploymentId: string;
	};
	readonly target: {
		readonly environmentId: string;
		readonly branch: string;
		readonly baseSha: string;
		readonly org: string;
		readonly orgId: string;
	};
	readonly branch: string;
	readonly title: string;
	readonly body: string;
	readonly components: ComponentSet;
	readonly operations: readonly RollbackOperation[];
	readonly packageXml: string;
	readonly destructiveChangesXml: string | null;
	readonly normalFlow: {
		readonly allowDestructiveChanges: boolean;
		readonly ready: boolean;
	};
	readonly identity: string;
}

type InternalOperation =
	| { readonly kind: 'delete'; readonly path: string; readonly change: 'deleted' }
	| {
			readonly kind: 'write';
			readonly path: string;
			readonly change: 'added' | 'modified';
			readonly mode: GitFileMode;
			readonly contents: string;
	  };

/** Internal file bytes stay out of CLI/audit output but feed one Git tree. */
export interface RollbackProposal {
	readonly plan: RollbackPlan;
	readonly files: readonly InternalOperation[];
	readonly report: string;
}

export interface BuildRollbackRequest {
	readonly repositoryDirectory: string;
	readonly sourceRun: RunRecord;
	/** Current exact commit of the configured target branch. */
	readonly currentBaseSha: string;
}

export const ROLLBACK_ARTIFACT_NAMES = {
	plan: 'rollback-plan.json',
	packageXml: 'package.xml',
	destructiveChangesXml: 'destructiveChanges.xml',
	report: 'report.md',
} as const;

/** Reads the target branch only from the exact trusted base configuration. */
export async function rollbackTargetBranch(
	repositoryDirectory: string,
	sourceRun: RunRecord,
): Promise<Result<string, DocketError>> {
	const config = await configAt(repositoryDirectory, sourceRun.plan.source.baseSha);
	if (!config.ok) return config;
	const environment = selectEnvironment(config.value, sourceRun.plan.target.environmentId);
	if (!environment.ok) return err(invalidSource(environment.error.message));
	if (environment.value.org !== sourceRun.plan.target.org) {
		return err(invalidSource('the trusted environment names a different Salesforce org'));
	}
	return ok(environment.value.branch);
}

/** Writes a reviewable proposal without ever writing the restored source bytes. */
export async function writeRollbackArtifacts(
	directory: string,
	proposal: RollbackProposal,
): Promise<Result<readonly string[], DocketError>> {
	const files = new Map<string, string>([
		[ROLLBACK_ARTIFACT_NAMES.plan, canonicalJsonFile(proposal.plan)],
		[ROLLBACK_ARTIFACT_NAMES.packageXml, proposal.plan.packageXml],
		[ROLLBACK_ARTIFACT_NAMES.report, proposal.report],
	]);
	if (proposal.plan.destructiveChangesXml !== null) {
		files.set(ROLLBACK_ARTIFACT_NAMES.destructiveChangesXml, proposal.plan.destructiveChangesXml);
	}

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

/**
 * M11.2–M11.5: calculate the exact compensating metadata change and stop if a
 * later commit touched the same component. Nothing here mutates Git or GitHub.
 */
export async function buildRollbackProposal(
	request: BuildRollbackRequest,
): Promise<Result<RollbackProposal, DocketError>> {
	const currentBase = parseCommitSha(
		request.currentBaseSha,
		'current target-branch SHA',
		ErrorCode.rollbackConflict,
	);
	if (!currentBase.ok) return currentBase;

	const source = request.sourceRun;
	const deploymentId = source.deployment?.deploymentId;
	if (deploymentId === undefined) {
		return err(invalidSource('the selected run has no deployment id'));
	}

	const sourceConfig = await configAt(request.repositoryDirectory, source.plan.source.baseSha);
	if (!sourceConfig.ok) return sourceConfig;
	const sourceEnvironment = selectEnvironment(sourceConfig.value, source.plan.target.environmentId);
	if (!sourceEnvironment.ok) return err(invalidSource(sourceEnvironment.error.message));

	const changes = await readChanges({
		cwd: request.repositoryDirectory,
		baseSha: source.plan.source.baseSha,
		headSha: source.plan.source.headSha,
	});
	if (!changes.ok) return changes;

	const verifiedSource = buildPlan({
		source: source.plan.source,
		environment: sourceEnvironment.value,
		orgId: source.plan.target.orgId,
		apiVersion: sourceConfig.value.apiVersion,
		sourceRoot: sourceConfig.value.sourceRoot,
		changes: changes.value,
	});
	if (!verifiedSource.ok || canonicalJson(verifiedSource.value.plan) !== canonicalJson(source.plan)) {
		return err(invalidSource('the run plan cannot be reproduced from its exact commits and base configuration'));
	}

	const currentConfig = await configAt(request.repositoryDirectory, currentBase.value);
	if (!currentConfig.ok) return currentConfig;
	const currentEnvironment = selectEnvironment(currentConfig.value, source.plan.target.environmentId);
	if (!currentEnvironment.ok) return err(conflict(currentEnvironment.error.message));

	const compatible = requireCurrentConfiguration(
		sourceConfig.value,
		sourceEnvironment.value,
		currentConfig.value,
		currentEnvironment.value,
		source,
	);
	if (!compatible.ok) return compatible;

	const operations = await inverseOperations(
		request.repositoryDirectory,
		source.plan.source.baseSha,
		source.plan.source.headSha,
		sourceConfig.value.sourceRoot,
		changes.value,
	);
	if (!operations.ok) return operations;
	if (operations.value.length === 0) {
		return err(invalidSource('the deployment contains no supported metadata change to invert'));
	}

	const noLaterChange = await requireUnchangedComponents({
		repositoryDirectory: request.repositoryDirectory,
		sourceHeadSha: source.plan.source.headSha,
		currentBaseSha: currentBase.value,
		sourceRoot: sourceConfig.value.sourceRoot,
		components: source.plan.components,
		operationPaths: operations.value.map((operation) => operation.path),
	});
	if (!noLaterChange.ok) return noLaterChange;

	const inverseComponents = invertComponents(source.plan.components);
	const operationComponents = collectComponents(
		operations.value.map(operationChange),
		{ sourceRoot: sourceConfig.value.sourceRoot },
	);
	if (
		!operationComponents.ok ||
		canonicalJson(operationComponents.value) !== canonicalJson(inverseComponents)
	) {
		return err(invalidSource('the source diff does not produce the recorded component inverse'));
	}

	const packageXml = renderPackageXml(inverseComponents.deployable, currentConfig.value.apiVersion);
	const destructiveChangesXml =
		inverseComponents.destructive.length === 0
			? null
			: renderPackageXml(inverseComponents.destructive, currentConfig.value.apiVersion);
	const publicOperations = operations.value.map(publicOperation);
	const branch = rollbackBranch(source, currentBase.value);
	const title = `Rollback deployment from PR #${source.plan.source.pullRequest}`;
	const body = rollbackBody(source, currentBase.value, publicOperations);
	const ready =
		inverseComponents.destructive.length === 0 || currentEnvironment.value.allowDestructiveChanges;

	const identityInput = {
		sourcePlanIdentity: source.plan.identity,
		sourceDeploymentId: deploymentId,
		currentBaseSha: currentBase.value,
		targetBranch: currentEnvironment.value.branch,
		operations: publicOperations,
		packageXmlDigest: digestOf(packageXml),
		destructiveChangesXmlDigest:
			destructiveChangesXml === null ? null : digestOf(destructiveChangesXml),
	};

	const plan: RollbackPlan = {
		schema: ROLLBACK_PLAN_SCHEMA,
		source: {
			repository: source.plan.source.repository,
			pullRequest: source.plan.source.pullRequest,
			baseSha: source.plan.source.baseSha,
			headSha: source.plan.source.headSha,
			planIdentity: source.plan.identity,
			deploymentId,
		},
		target: {
			environmentId: source.plan.target.environmentId,
			branch: currentEnvironment.value.branch,
			baseSha: currentBase.value,
			org: source.plan.target.org,
			orgId: source.plan.target.orgId,
		},
		branch,
		title,
		body,
		components: inverseComponents,
		operations: publicOperations,
		packageXml,
		destructiveChangesXml,
		normalFlow: {
			allowDestructiveChanges: currentEnvironment.value.allowDestructiveChanges,
			ready,
		},
		identity: digestOf(canonicalJson(identityInput)),
	};

	return ok({ plan, files: operations.value, report: renderRollbackReport(plan) });
}

function invertComponents(components: ComponentSet): ComponentSet {
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
}

async function inverseOperations(
	cwd: string,
	baseSha: string,
	headSha: string,
	sourceRoot: string,
	changes: readonly FileChange[],
): Promise<Result<readonly InternalOperation[], DocketError>> {
	const operations = new Map<string, InternalOperation>();

	for (const change of changes) {
		const current = classifyPath(change.path, { sourceRoot });
		if (!current.ok) return current;

		if (change.status === 'renamed') {
			const previous = classifyPath(change.previousPath, { sourceRoot });
			if (!previous.ok) return previous;

			if (current.value.kind === 'component') {
				const added = await addOperation(operations, {
					kind: 'delete',
					path: change.path,
					change: 'deleted',
				});
				if (!added.ok) return added;
			}
			if (previous.value.kind === 'component') {
				const restored = await restoreOperation(
					cwd,
					baseSha,
					change.previousPath,
					'added',
				);
				if (!restored.ok) return restored;
				const added = await addOperation(operations, restored.value);
				if (!added.ok) return added;
			}
			continue;
		}

		if (current.value.kind === 'ignored') continue;
		if (change.status === 'added') {
			const head = await readPathAtCommit(cwd, headSha, change.path);
			if (!head.ok) return head;
			if (head.value.kind !== 'file') return err(invalidSource(`added path \`${change.path}\` is absent at head`));
			const added = await addOperation(operations, {
				kind: 'delete',
				path: change.path,
				change: 'deleted',
			});
			if (!added.ok) return added;
			continue;
		}

		const restored = await restoreOperation(
			cwd,
			baseSha,
			change.path,
			change.status === 'modified' ? 'modified' : 'added',
		);
		if (!restored.ok) return restored;
		const added = await addOperation(operations, restored.value);
		if (!added.ok) return added;
	}

	return ok([...operations.values()].sort((left, right) => compareText(left.path, right.path)));
}

async function restoreOperation(
	cwd: string,
	baseSha: string,
	path: string,
	change: 'added' | 'modified',
): Promise<Result<InternalOperation, DocketError>> {
	const base = await readPathAtCommit(cwd, baseSha, path);
	if (!base.ok) return base;
	if (base.value.kind !== 'file') {
		return err(invalidSource(`cannot restore \`${path}\`: it is absent from the source base`));
	}

	return ok({
		kind: 'write',
		path,
		change,
		mode: base.value.mode,
		contents: base.value.contents,
	});
}

function addOperation(
	operations: Map<string, InternalOperation>,
	operation: InternalOperation,
): Result<void, DocketError> {
	const existing = operations.get(operation.path);
	if (existing === undefined) {
		operations.set(operation.path, operation);
		return ok(undefined);
	}
	if (canonicalJson(existing) === canonicalJson(operation)) return ok(undefined);

	return err(invalidSource(`the inverse asks for two different operations on \`${operation.path}\``));
}

async function requireUnchangedComponents(request: {
	readonly repositoryDirectory: string;
	readonly sourceHeadSha: string;
	readonly currentBaseSha: string;
	readonly sourceRoot: string;
	readonly components: ComponentSet;
	readonly operationPaths: readonly string[];
}): Promise<Result<void, DocketError>> {
	const touched = new Set(
		[...request.components.deployable, ...request.components.destructive].map(componentKey),
	);
	const paths = new Set(request.operationPaths);

	for (const sha of [request.sourceHeadSha, request.currentBaseSha]) {
		const listed = await listPathsAtCommit(request.repositoryDirectory, sha, request.sourceRoot);
		if (!listed.ok) return listed;

		for (const path of listed.value) {
			const classified = classifyPath(path, { sourceRoot: request.sourceRoot });
			if (classified.ok && classified.value.kind === 'component' && touched.has(componentKey(classified.value.component))) {
				paths.add(path);
			}
		}
	}

	const conflicts: string[] = [];
	for (const path of [...paths].sort(compareText)) {
		const before = await readPathAtCommit(request.repositoryDirectory, request.sourceHeadSha, path);
		if (!before.ok) return before;
		const current = await readPathAtCommit(request.repositoryDirectory, request.currentBaseSha, path);
		if (!current.ok) return current;
		if (!samePathState(before.value, current.value)) conflicts.push(path);
	}

	return conflicts.length === 0
		? ok(undefined)
		: err(conflict(`later commits changed: ${conflicts.map((path) => `\`${path}\``).join(', ')}`));
}

function samePathState(left: GitPathState, right: GitPathState): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind === 'absent' ||
		(right.kind === 'file' && left.mode === right.mode && left.blobSha === right.blobSha);
}

function operationChange(operation: InternalOperation): FileChange {
	return { status: operation.change, path: operation.path };
}

function publicOperation(operation: InternalOperation): RollbackOperation {
	return operation.kind === 'delete'
		? { ...operation, contentDigest: null, mode: null }
		: {
				kind: operation.kind,
				path: operation.path,
				change: operation.change,
				contentDigest: digestOf(operation.contents),
				mode: operation.mode,
			};
}

async function configAt(cwd: string, sha: string): Promise<Result<DocketConfig, DocketError>> {
	const file = await readFileAtCommit({ cwd, sha, path: CONFIG_FILE_NAME });
	if (!file.ok) return file;
	return parseConfig(file.value);
}

function requireCurrentConfiguration(
	sourceConfig: DocketConfig,
	sourceEnvironment: EnvironmentConfig,
	currentConfig: DocketConfig,
	currentEnvironment: EnvironmentConfig,
	source: RunRecord,
): Result<void, DocketError> {
	const changes: string[] = [];
	if (currentConfig.sourceRoot !== sourceConfig.sourceRoot) changes.push('sourceRoot');
	if (currentEnvironment.branch !== sourceEnvironment.branch) changes.push('target branch');
	if (currentEnvironment.org !== source.plan.target.org) changes.push('Salesforce org reference');
	if (currentEnvironment.id !== source.plan.target.environmentId) changes.push('environment id');

	return changes.length === 0
		? ok(undefined)
		: err(conflict(`current configuration changed the ${changes.join(', ')}`));
}

function rollbackBranch(source: RunRecord, currentBaseSha: string): string {
	return `docket/rollback-pr${source.plan.source.pullRequest}-${source.plan.source.headSha.slice(0, 8)}-${currentBaseSha.slice(0, 8)}`;
}

function rollbackBody(
	source: RunRecord,
	currentBaseSha: string,
	operations: readonly RollbackOperation[],
): string {
	const lines = [
		'This compensating pull request was calculated by Docket.',
		'',
		`- Source PR: #${source.plan.source.pullRequest}`,
		`- Source plan: \`${source.plan.identity}\``,
		`- Salesforce deployment: \`${oneLine(source.deployment?.deploymentId ?? 'unknown')}\``,
		`- Target base: \`${currentBaseSha}\``,
		'',
		'It must pass the ordinary Docket validation check, be merged manually, and then use the ordinary post-merge deployment workflow.',
		'',
		'File operations:',
		...operations.map((operation) => `- ${operation.kind} \`${operation.path}\``),
	];

	return `${lines.join('\n')}\n`;
}

function renderRollbackReport(plan: RollbackPlan): string {
	const lines = [
		'# Docket rollback proposal',
		'',
		`- Source pull request: #${plan.source.pullRequest}`,
		`- Source deployment: \`${plan.source.deploymentId}\``,
		`- Target: \`${plan.target.environmentId}\` / \`${plan.target.orgId}\``,
		`- Target base: \`${plan.target.baseSha}\``,
		`- Rollback identity: \`${plan.identity}\``,
		'',
		'## Components',
		'',
		'| Type | Member | Change |',
		'| --- | --- | --- |',
		...([...plan.components.deployable, ...plan.components.destructive].map(
			(component) => `| ${component.type} | ${component.member} | ${component.change} |`,
		)),
		'',
		'## Files',
		'',
		'| Operation | Path | Content |',
		'| --- | --- | --- |',
		...plan.operations.map(
			(operation) =>
				`| ${operation.kind} | ${operation.path.replaceAll('|', '\\|')} | ${operation.contentDigest ?? 'delete'} |`,
		),
		'',
		plan.normalFlow.ready
			? 'The current environment policy admits this inverse through the normal PR flow.'
			: 'Blocked: the inverse deletes metadata, but the current environment policy forbids destructive changes.',
		'',
	];

	return lines.join('\n');
}

function invalidSource(problem: string): DocketError {
	return docketError(ErrorCode.rollbackSourceInvalid, `cannot build rollback: ${problem}`);
}

function conflict(problem: string): DocketError {
	return docketError(ErrorCode.rollbackConflict, `cannot build rollback: ${problem}`);
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, ' ');
}
