import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import type { GitFileMode } from '../git/tree.ts';
import type { ComponentSet } from '../metadata/component-set.ts';

export const ROLLBACK_PLAN_SCHEMA = 'docket.rollback-plan/v1';

/** One file operation, as the reviewable plan states it: digests, not bytes. */
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

/** The same operation with the bytes attached, for building one Git tree. */
export type RollbackFileOperation =
	| { readonly kind: 'delete'; readonly path: string; readonly change: 'deleted' }
	| {
			readonly kind: 'write';
			readonly path: string;
			readonly change: 'added' | 'modified';
			readonly mode: GitFileMode;
			readonly contents: string;
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

/** File bytes stay out of CLI and audit output, and feed one Git tree instead. */
export interface RollbackProposal {
	readonly plan: RollbackPlan;
	readonly files: readonly RollbackFileOperation[];
	readonly report: string;
}

/**
 * The two ways a rollback is refused, kept together because the difference is
 * the whole answer: the run itself cannot be inverted, or the repository has
 * moved on since it was deployed.
 */
export function invalidSource(problem: string): DocketError {
	return docketError(ErrorCode.rollbackSourceInvalid, `cannot build rollback: ${problem}`);
}

export function conflict(problem: string): DocketError {
	return docketError(ErrorCode.rollbackConflict, `cannot build rollback: ${problem}`);
}
