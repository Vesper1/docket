import { runProcess } from '../../shared/process/run-process.ts';
import type { GateDefinition, StepDefinition } from '../config/docket-config.ts';
import type { LogFile } from '../run/write-artifacts.ts';
import type { StepResult } from '../validation/validation-record.ts';

/**
 * Variables removed before a hook or a gate runs.
 *
 * A gate executes code from the pull request, and §4 says candidate checks run
 * without deployment credentials. Removing them from the environment is a
 * barrier, not a sandbox — a command can still read a cached CLI login on the
 * same machine — so a hostile change is still a hostile change.
 *
 * The `ACTIONS_*` variables belong here for the same reason as the Salesforce
 * ones: on a runner they are credentials. `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
 * mints an OIDC token — the identity a later Docket is meant to authenticate to
 * Salesforce with — and `ACTIONS_RUNTIME_TOKEN` writes the artifacts a
 * deployment reads back as its own plan.
 */
const CREDENTIAL_VARIABLES = [
	'SF_AUTH_URL',
	'SFDX_AUTH_URL',
	'SF_ACCESS_TOKEN',
	'SFDX_ACCESS_TOKEN',
	'SF_CLIENT_SECRET',
	'SF_JWT_KEY',
	'SF_JWT_KEY_FILE',
	'GITHUB_TOKEN',
	'GH_TOKEN',
	'ACTIONS_RUNTIME_TOKEN',
	'ACTIONS_RUNTIME_URL',
	'ACTIONS_RESULTS_URL',
	'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
	'ACTIONS_ID_TOKEN_REQUEST_URL',
];

export interface StepRunRequest {
	/** Where the commands run — the candidate workspace for gates. */
	readonly cwd: string;
	readonly kind: 'gate' | 'pre' | 'post';
	/** Strips Salesforce and GitHub credentials from the environment. */
	readonly withoutCredentials: boolean;
	readonly signal?: AbortSignal;
	/** Names of manual steps already completed, for a pre-deployment run. */
	readonly completed?: ReadonlySet<string>;
	/** Who completed each of those, as the completion record names them. */
	readonly completedBy?: ReadonlyMap<string, string>;
}

export interface StepRunOutcome {
	readonly results: readonly StepResult[];
	readonly logs: readonly LogFile[];
}

/** Gates are automatic by definition: a person cannot be a quality gate. */
export function runGates(
	gates: readonly GateDefinition[],
	request: Omit<StepRunRequest, 'kind'>,
): Promise<StepRunOutcome> {
	return runSteps(
		gates.map((gate) => ({
			kind: 'automatic' as const,
			name: gate.name,
			run: gate.run,
			timeoutMinutes: gate.timeoutMinutes,
		})),
		{ ...request, kind: 'gate' },
	);
}

/**
 * Runs an ordered list of steps, stopping at the first failure.
 *
 * Everything after a failure is recorded as `skipped` rather than dropped: the
 * run must show that a later step did not run, not leave a reader guessing
 * whether it passed silently.
 */
export async function runSteps(
	steps: readonly StepDefinition[],
	request: StepRunRequest,
): Promise<StepRunOutcome> {
	const results: StepResult[] = [];
	const logs: LogFile[] = [];
	let stopped = false;

	for (const step of steps) {
		if (stopped) {
			results.push(skipped(step, request.kind));
			continue;
		}

		if (step.kind === 'manual') {
			const done = request.completed?.has(step.name) === true;
			results.push({
				name: step.name,
				kind: request.kind,
				manual: true,
				status: done ? 'passed' : 'pending',
				exitCode: null,
				completedBy: request.completedBy?.get(step.name) ?? null,
			});
			// A pending manual step is not a failure, but nothing after it may
			// run either: the runbook is ordered on purpose.
			if (!done) stopped = true;
			continue;
		}

		const process = await runProcess('bash', ['-c', step.run], {
			cwd: request.cwd,
			timeoutMs: step.timeoutMinutes * 60_000,
			...(request.withoutCredentials ? { removeEnv: CREDENTIAL_VARIABLES } : {}),
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});

		const passed =
			process.startError === null && process.exitCode === 0 && process.terminatedBy === null;
		results.push({
			name: step.name,
			kind: request.kind,
			manual: false,
			status: passed ? 'passed' : 'failed',
			exitCode: process.exitCode,
			completedBy: null,
		});
		logs.push({
			name: `${request.kind}-${step.name}.log`,
			contents: logOf(step.run, process),
		});

		if (!passed) stopped = true;
	}

	return { results, logs };
}

function skipped(step: StepDefinition, kind: StepRunRequest['kind']): StepResult {
	return {
		name: step.name,
		kind,
		manual: step.kind === 'manual',
		status: 'skipped',
		exitCode: null,
		completedBy: null,
	};
}

function logOf(
	command: string,
	process: {
		stdout: string;
		stderr: string;
		exitCode: number;
		terminatedBy: string | null;
		startError: string | null;
	},
): string {
	return [
		`$ ${command}`,
		process.stdout,
		process.stderr,
		process.startError !== null
			? `failed to start: ${process.startError}`
			: process.terminatedBy === null
			? `exit ${process.exitCode}`
			: `${process.terminatedBy} after exit ${process.exitCode}`,
		'',
	].join('\n');
}
