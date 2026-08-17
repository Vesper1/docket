import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { compareText } from '../../shared/text/compare-text.ts';
import type { DocketConfig, EnvironmentConfig } from '../config/docket-config.ts';
import { listPathsAtCommit, readPathAtCommit } from '../git/tree.ts';
import type { GitPathState } from '../git/tree.ts';
import { classifyPath } from '../metadata/classify-path.ts';
import type { ComponentSet } from '../metadata/component-set.ts';
import { componentKey } from '../metadata/metadata-component.ts';
import type { RunRecord } from '../run/run-record.ts';
import { conflict } from './rollback-plan.ts';

/**
 * Whether the repository has moved on since the deployment being undone.
 *
 * A rollback is only safe while nothing else has touched what it restores. If
 * a later commit changed one of those paths, the inverse would silently revert
 * that work too, so the proposal stops and names the paths instead.
 */
export async function requireUnchangedComponents(request: {
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
			if (
				classified.ok &&
				classified.value.kind === 'component' &&
				touched.has(componentKey(classified.value.component))
			) {
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

/**
 * Whether the configuration still describes the same deployment.
 *
 * The plan was built against one source root, branch and org. If any of those
 * have since been repointed, the inverse would be aimed somewhere else.
 */
export function requireCurrentConfiguration(
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

function samePathState(left: GitPathState, right: GitPathState): boolean {
	if (left.kind !== right.kind) return false;
	return (
		left.kind === 'absent' ||
		(right.kind === 'file' && left.mode === right.mode && left.blobSha === right.blobSha)
	);
}
