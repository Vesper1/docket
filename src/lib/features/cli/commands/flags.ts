import type { FlagSpec } from './command.ts';

/**
 * Docket's flag vocabulary.
 *
 * A flag means one thing across the whole program: `--head` is always an exact
 * commit, `--run` is always a recorded run. Commands pick the words they read —
 * that choice is what they accept — but none of them may redefine one.
 */
const FLAGS = {
	repo: {
		type: 'string',
		description: 'Repository to read (default: current directory)',
	},
	base: {
		type: 'string',
		description: 'Full SHA of the base commit',
	},
	head: {
		type: 'string',
		description: 'Full SHA of the head commit',
	},
	repository: {
		type: 'string',
		description: 'GitHub repository as owner/name',
	},
	'pull-request': {
		type: 'string',
		description: 'Pull request number',
	},
	environment: {
		type: 'string',
		description: 'Environment id from docket.yml',
	},
	'target-branch': {
		type: 'string',
		description: 'Branch the pull request targets',
	},
	'org-id': {
		type: 'string',
		description: 'Skip org resolution and bind the plan to this org id',
	},
	out: {
		type: 'string',
		description: 'Directory for run artifacts',
	},
	sf: {
		type: 'string',
		description: 'Salesforce CLI executable (default: sf)',
	},
	wait: {
		type: 'string',
		description: 'Minutes to wait for Salesforce (default: 33)',
	},
	'validated-run': {
		type: 'string',
		description: 'Artifacts directory of the validation to deploy',
	},
	'gates-run': {
		type: 'string',
		description: 'Artifacts directory of credential-free passing gates',
	},
	'merge-commit': {
		type: 'string',
		description: 'Commit GitHub produced by merging the pull request',
	},
	'github-token': {
		type: 'string',
		description: 'GitHub token (prefer GITHUB_TOKEN in the environment)',
	},
	'require-merged': {
		type: 'boolean',
		description: 'Verify with GitHub that the pull request was merged',
	},
	'workflow-run-id': {
		type: 'string',
		description: 'Workflow run the validation artifacts belong to',
	},
	'workflow-run-attempt': {
		type: 'string',
		description: 'Attempt number for that workflow run',
	},
	'expected-plan-identity': {
		type: 'string',
		description: 'Plan identity selected by the green check',
	},
	'artifacts-expire-at': {
		type: 'string',
		description: "ISO-8601 instant this run's artifacts expire",
	},
	'details-url': {
		type: 'string',
		description: 'Link the published check points at',
	},
	steps: {
		type: 'string',
		description: 'Directory of manual-step completion records',
	},
	step: {
		type: 'string',
		description: 'Name of the manual step being completed',
	},
	by: {
		type: 'string',
		description: 'Who completed that step',
	},
	run: {
		type: 'string',
		description: 'Recorded deployment artifacts selected for rollback',
	},
	runs: {
		type: 'string',
		description: 'Root containing deployment run artifact directories',
	},
	'create-pr': {
		type: 'boolean',
		description: 'Publish the rollback as a new GitHub pull request',
	},
} as const satisfies Readonly<Record<string, FlagSpec>>;

export type FlagName = keyof typeof FLAGS;

/** The flags one command accepts, named once, in the order help prints them. */
export function flagsFor<const Names extends readonly FlagName[]>(
	...names: Names
): { readonly [Name in Names[number]]: (typeof FLAGS)[Name] } {
	return Object.fromEntries(names.map((name) => [name, FLAGS[name]])) as {
		readonly [Name in Names[number]]: (typeof FLAGS)[Name];
	};
}

/** Every word in the vocabulary, for the checks that keep it honest. */
export const FLAG_NAMES: readonly FlagName[] = Object.keys(FLAGS) as FlagName[];
