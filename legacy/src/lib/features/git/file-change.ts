/**
 * What happened to one file between two exact commits.
 *
 * This is the first domain model in Docket, and everything downstream is
 * derived from it: a status decides whether a path becomes a deployable
 * manifest member or a destructive one, so it must never be inferred later
 * from a file name or from the presence of the file on disk.
 */
export const ChangeStatus = {
	/** The path exists in the head commit and did not exist in the base commit. */
	added: 'added',
	/** The path exists in both commits with different contents. */
	modified: 'modified',
	/** The path existed in the base commit and is gone from the head commit. */
	deleted: 'deleted',
	/** The same content reached a new path; both paths matter to a plan. */
	renamed: 'renamed',
} as const;

export type ChangeStatus = (typeof ChangeStatus)[keyof typeof ChangeStatus];

/**
 * One typed change, carrying repository-relative paths.
 *
 * A rename is a separate member of the union rather than an optional field: a
 * rename that loses its old path silently becomes an addition, and the deleted
 * half of it would never reach a destructive manifest.
 */
export type FileChange =
	| {
			readonly status: 'added' | 'modified' | 'deleted';
			readonly path: string;
	  }
	| {
			readonly status: 'renamed';
			/** Where the file is in the head commit. */
			readonly path: string;
			/** Where the file was in the base commit. */
			readonly previousPath: string;
	  };
