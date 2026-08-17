import { canonicalJson, digestOf } from '../../shared/json/canonical-json.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { compareText } from '../../shared/text/compare-text.ts';
import type { FileChange } from '../git/file-change.ts';
import { readPathAtCommit } from '../git/tree.ts';
import { classifyPath } from '../metadata/classify-path.ts';
import type { ComponentSet, PlannedComponent } from '../metadata/component-set.ts';
import { compareComponents } from '../metadata/metadata-component.ts';
import { invalidSource } from './rollback-plan.ts';
import type { RollbackFileOperation, RollbackOperation } from './rollback-plan.ts';

/**
 * The component-level inverse: what was added is deleted, what was deleted is
 * added back, and what was modified is modified again — to the bytes the
 * deployment started from.
 */
export function invertComponents(components: ComponentSet): ComponentSet {
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

/**
 * The file-level inverse, read out of the exact commits the deployment used.
 *
 * Restored contents come from the source base commit, never from the working
 * tree, so a rollback proposes the bytes that were actually deployed over.
 */
export async function inverseOperations(
	cwd: string,
	baseSha: string,
	headSha: string,
	sourceRoot: string,
	changes: readonly FileChange[],
): Promise<Result<readonly RollbackFileOperation[], DocketError>> {
	const operations = new Map<string, RollbackFileOperation>();

	for (const change of changes) {
		const current = classifyPath(change.path, { sourceRoot });
		if (!current.ok) return current;

		if (change.status === 'renamed') {
			const previous = classifyPath(change.previousPath, { sourceRoot });
			if (!previous.ok) return previous;

			if (current.value.kind === 'component') {
				const added = addOperation(operations, {
					kind: 'delete',
					path: change.path,
					change: 'deleted',
				});
				if (!added.ok) return added;
			}
			if (previous.value.kind === 'component') {
				const restored = await restoreOperation(cwd, baseSha, change.previousPath, 'added');
				if (!restored.ok) return restored;
				const added = addOperation(operations, restored.value);
				if (!added.ok) return added;
			}
			continue;
		}

		if (current.value.kind === 'ignored') continue;
		if (change.status === 'added') {
			const head = await readPathAtCommit(cwd, headSha, change.path);
			if (!head.ok) return head;
			if (head.value.kind !== 'file') {
				return err(invalidSource(`added path \`${change.path}\` is absent at head`));
			}
			const added = addOperation(operations, {
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
		const added = addOperation(operations, restored.value);
		if (!added.ok) return added;
	}

	return ok([...operations.values()].sort((left, right) => compareText(left.path, right.path)));
}

/** The change an inverse operation represents, for re-deriving its component. */
export function operationChange(operation: RollbackFileOperation): FileChange {
	return { status: operation.change, path: operation.path };
}

/** The public form of an operation: a digest of the contents, never the contents. */
export function publicOperation(operation: RollbackFileOperation): RollbackOperation {
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

async function restoreOperation(
	cwd: string,
	baseSha: string,
	path: string,
	change: 'added' | 'modified',
): Promise<Result<RollbackFileOperation, DocketError>> {
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

/** Two different operations on one path mean the inverse is not a function. */
function addOperation(
	operations: Map<string, RollbackFileOperation>,
	operation: RollbackFileOperation,
): Result<void, DocketError> {
	const existing = operations.get(operation.path);
	if (existing === undefined) {
		operations.set(operation.path, operation);
		return ok(undefined);
	}
	if (canonicalJson(existing) === canonicalJson(operation)) return ok(undefined);

	return err(invalidSource(`the inverse asks for two different operations on \`${operation.path}\``));
}
