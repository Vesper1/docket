import type { DocketError } from '../../shared/result/docket-error.ts';
import { ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME } from '../config/docket-config.ts';
import type { DocketConfig, EnvironmentConfig } from '../config/docket-config.ts';
import { parseConfig } from '../config/parse-config.ts';
import { requireTargetBranch, selectEnvironment } from '../config/select-environment.ts';
import { readChanges } from '../git/read-changes.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { buildPlan } from '../plan/build-plan.ts';
import type { PlanArtifacts, PlanSource } from '../plan/deployment-plan.ts';

export interface PrepareRequest {
	/** A git repository containing both commits. */
	readonly repositoryDirectory: string;
	readonly source: PlanSource;
	readonly environmentId: string;
	/**
	 * The branch the pull request targets. Given when GitHub is the source of
	 * truth; omitted for a local run that has no pull request to check.
	 */
	readonly targetBranch: string | undefined;
}

/** Resolves an org reference to the org id a plan is bound to. */
export type OrgIdResolver = (reference: string) => Promise<Result<string, DocketError>>;

export interface PreparedRun {
	readonly config: DocketConfig;
	readonly environment: EnvironmentConfig;
	readonly plan: PlanArtifacts;
}

/**
 * Phase A and Phase B, in the order the contract states them.
 *
 * Configuration is read from the base commit before anything else happens, so
 * every later decision — which org, which tests, whether deletion is allowed —
 * comes from code that was already merged, not from the change under review.
 */
export async function prepareRun(
	request: PrepareRequest,
	resolveOrgId: OrgIdResolver,
): Promise<Result<PreparedRun, DocketError>> {
	const text = await readFileAtCommit({
		cwd: request.repositoryDirectory,
		sha: request.source.baseSha,
		path: CONFIG_FILE_NAME,
	});
	if (!text.ok) return text;

	const config = parseConfig(text.value);
	if (!config.ok) return config;

	const selected = selectEnvironment(config.value, request.environmentId);
	if (!selected.ok) return selected;

	if (request.targetBranch !== undefined) {
		const matched = requireTargetBranch(selected.value, request.targetBranch);
		if (!matched.ok) return matched;
	}

	const changes = await readChanges({
		cwd: request.repositoryDirectory,
		baseSha: request.source.baseSha,
		headSha: request.source.headSha,
	});
	if (!changes.ok) return changes;

	// Resolved before the plan is built, because the org id is part of what the
	// plan promises and an alias is only a local nickname for it.
	const orgId = await resolveOrgId(selected.value.org);
	if (!orgId.ok) return orgId;

	const plan = buildPlan({
		source: request.source,
		environment: selected.value,
		orgId: orgId.value,
		apiVersion: config.value.apiVersion,
		sourceRoot: config.value.sourceRoot,
		changes: changes.value,
	});
	if (!plan.ok) return plan;

	return ok({ config: config.value, environment: selected.value, plan: plan.value });
}
