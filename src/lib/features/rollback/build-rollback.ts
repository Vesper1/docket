import { canonicalJson, digestOf } from '../../shared/json/canonical-json.ts';
import { ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME } from '../config/docket-config.ts';
import type { DocketConfig } from '../config/docket-config.ts';
import { parseConfig } from '../config/parse-config.ts';
import { selectEnvironment } from '../config/select-environment.ts';
import { parseCommitSha } from '../git/commit-sha.ts';
import { readChanges } from '../git/read-changes.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { collectComponents } from '../metadata/component-set.ts';
import { renderPackageXml } from '../metadata/package-xml.ts';
import { buildPlan } from '../plan/build-plan.ts';
import type { RunRecord } from '../run/run-record.ts';
import {
	inverseOperations,
	invertComponents,
	operationChange,
	publicOperation,
} from './inverse-change.ts';
import { requireCurrentConfiguration, requireUnchangedComponents } from './rollback-conflict.ts';
import { conflict, invalidSource, ROLLBACK_PLAN_SCHEMA } from './rollback-plan.ts';
import type { RollbackPlan, RollbackProposal } from './rollback-plan.ts';
import { renderRollbackReport, rollbackBody, rollbackBranch } from './rollback-report.ts';

export interface BuildRollbackRequest {
	readonly repositoryDirectory: string;
	readonly sourceRun: RunRecord;
	/** Current exact commit of the configured target branch. */
	readonly currentBaseSha: string;
}

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
	const operationComponents = collectComponents(operations.value.map(operationChange), {
		sourceRoot: sourceConfig.value.sourceRoot,
	});
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
		branch: rollbackBranch(source, currentBase.value),
		title: `Rollback deployment from PR #${source.plan.source.pullRequest}`,
		body: rollbackBody(source, currentBase.value, publicOperations),
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

async function configAt(cwd: string, sha: string): Promise<Result<DocketConfig, DocketError>> {
	const file = await readFileAtCommit({ cwd, sha, path: CONFIG_FILE_NAME });
	if (!file.ok) return file;
	return parseConfig(file.value);
}
