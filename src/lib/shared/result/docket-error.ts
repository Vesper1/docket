/**
 * Stable machine-readable failure codes.
 *
 * These are a public contract: CI scripts, workflow steps and future GitHub
 * checks branch on them. A code may be added or retired, but an existing code
 * never changes meaning and is never reworded into something else.
 */
export const ErrorCode = {
	/** The first positional argument is not a command Docket knows. */
	unknownCommand: 'unknown_command',
	/** A flag was misspelled, unknown, or given the wrong kind of value. */
	invalidOption: 'invalid_option',
	/** A flag the command cannot run without was not given at all. */
	missingOption: 'missing_option',
	/** git refused the request: an unknown ref, a broken or missing repository. */
	gitFailed: 'git_failed',
	/** A real change Docket cannot classify yet, and refuses to leave out. */
	unsupportedChange: 'unsupported_change',
	/** A path inside the source directory that maps to no known metadata type. */
	unsupportedMetadata: 'unsupported_metadata',
	/** `docket.yml` is unreadable, malformed, or says something Docket rejects. */
	invalidConfig: 'invalid_config',
	/** The run asked for an environment `docket.yml` does not define. */
	unknownEnvironment: 'unknown_environment',
	/** The pull request targets a branch the chosen environment does not deploy. */
	branchMismatch: 'branch_mismatch',
	/** The plan deletes metadata in an environment whose policy forbids it. */
	destructiveNotAllowed: 'destructive_not_allowed',
	/** The Salesforce CLI could not be run or answered something unreadable. */
	salesforceFailed: 'salesforce_failed',
	/** The configured org cannot be reached, or is not authenticated. */
	orgUnavailable: 'org_unavailable',
	/** The org in front of Docket is not the org the plan was validated against. */
	orgMismatch: 'org_mismatch',
	/** An artifact about to be written contains credential-shaped text. */
	secretInArtifact: 'secret_in_artifact',
	/** The plan offered for deployment is not the plan that was validated. */
	planMismatch: 'plan_mismatch',
	/** Deployment was asked for a run whose validation did not pass. */
	validationNotPassed: 'validation_not_passed',
	/** GitHub could not be reached, or refused the request. */
	githubFailed: 'github_failed',
	/** The pull request is a fork, a draft, closed, or otherwise out of scope. */
	pullRequestNotEligible: 'pull_request_not_eligible',
	/** A required manual step has not been completed for this exact plan. */
	stepIncomplete: 'step_incomplete',
	/** A completed step cannot be completed again: its record is immutable. */
	stepAlreadyCompleted: 'step_already_completed',
	/** A recorded run is not a successful deployment that rollback may invert. */
	rollbackSourceInvalid: 'rollback_source_invalid',
	/** A later repository change overlaps the deployment a rollback would undo. */
	rollbackConflict: 'rollback_conflict',
	/** Run artifacts cannot be assembled into one trustworthy deployment history. */
	historyInvalid: 'history_invalid',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * A failure Docket can explain. `message` is for humans and may be reworded at
 * any time; `code` is for machines and may not.
 */
export interface DocketError {
	readonly code: ErrorCode;
	readonly message: string;
}

export const docketError = (code: ErrorCode, message: string): DocketError => ({ code, message });
