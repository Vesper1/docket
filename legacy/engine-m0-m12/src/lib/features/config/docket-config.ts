import { DEFAULT_SOURCE_ROOT } from '../metadata/classify-path.ts';
import { DEFAULT_API_VERSION } from '../metadata/package-xml.ts';

export { DEFAULT_API_VERSION, DEFAULT_SOURCE_ROOT };

/** Where Docket looks for its configuration, at the repository root. */
export const CONFIG_FILE_NAME = 'docket.yml';

/**
 * `docket.yml`, normalized.
 *
 * Desired configuration only. Nothing here is ever written back: a validation
 * verdict, a lock or a run history in this file would make the repository the
 * runtime state store, which §4 forbids.
 */
export interface DocketConfig {
	/** Schema version of the file itself, so a future shape can be detected. */
	readonly version: 1;
	/** Repository-relative directory holding Salesforce source. */
	readonly sourceRoot: string;
	/** Metadata API version every manifest of this repository is written against. */
	readonly apiVersion: string;
	/** Sorted by id, so a normalized config is byte-stable. */
	readonly environments: readonly EnvironmentConfig[];
}

/**
 * A quality gate: a command the candidate must pass before Salesforce is asked
 * anything. It runs against the pull request's code but is defined by the base
 * commit, and never receives deployment credentials (§4).
 */
export interface GateDefinition {
	readonly name: string;
	/** A command line, run through Bash in the candidate workspace. */
	readonly run: string;
	readonly timeoutMinutes: number;
}

/**
 * A pre- or post-deployment step.
 *
 * Automatic steps are commands Docket runs; manual ones are things a person
 * does, which Docket only tracks. The two are one ordered list because their
 * order relative to each other is what a release runbook actually is.
 */
export type StepDefinition =
	| {
			readonly kind: 'automatic';
			readonly name: string;
			readonly run: string;
			readonly timeoutMinutes: number;
	  }
	| {
			readonly kind: 'manual';
			readonly name: string;
			/** What the person has to do before the deployment may proceed. */
			readonly instructions: string;
	  };

/** How long a hook may run before Docket stops waiting for it. */
export const DEFAULT_STEP_TIMEOUT_MINUTES = 10;

export interface EnvironmentConfig {
	/** How a run names this environment: `docket … --environment qa`. */
	readonly id: string;
	/** The branch a pull request must target to reach this environment. */
	readonly branch: string;
	/**
	 * A reference to a Salesforce org — an alias or username. Never a
	 * credential: §3 keeps secrets out of Git entirely.
	 */
	readonly org: string;
	/** Whether a plan for this environment may delete metadata at all. */
	readonly allowDestructiveChanges: boolean;
	readonly tests: TestSelection;
	/** Candidate checks, run before validation. */
	readonly gates: readonly GateDefinition[];
	/** Ordered steps that must happen before the deployment. */
	readonly preDeployment: readonly StepDefinition[];
	/** Ordered automatic steps that happen after a deployment has run. */
	readonly postDeployment: readonly StepDefinition[];
}

/**
 * Which Apex tests a validation and its deployment run.
 *
 * The MVP offers exactly the two the contract names: everything, or a list
 * someone wrote down deliberately.
 */
export type TestSelection =
	| { readonly mode: 'all' }
	| { readonly mode: 'specified'; readonly classes: readonly string[] };
