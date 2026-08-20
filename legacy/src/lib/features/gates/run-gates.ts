import { runProcess } from '../../shared/process/run-process.ts';
import type { GateDefinition } from '../config/config.ts';

/**
 * Variables removed before a gate runs.
 *
 * A gate executes code from the candidate commit, so it must not see the
 * credentials the deployment holds. Removing them from the environment is a
 * barrier, not a sandbox — a command can still read a cached CLI login on the
 * same machine — so a hostile change is still a hostile change.
 *
 * The `ACTIONS_*` variables belong here for the same reason as the Salesforce
 * ones: on a runner they are credentials. `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
 * mints an OIDC identity, and `ACTIONS_RUNTIME_TOKEN` writes workflow artifacts.
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

export interface GateResult {
	readonly name: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly exitCode: number | null;
	/** Command line, stdout, stderr and how the process ended. */
	readonly log: string;
}

export interface GateOutcome {
	readonly passed: boolean;
	readonly results: readonly GateResult[];
}

/**
 * Runs the configured gates in order, stopping at the first failure.
 *
 * Everything after a failure is recorded as `skipped` rather than dropped: the
 * run must show that a later gate did not run, not leave a reader guessing
 * whether it passed silently.
 */
export const runGates = async (
	gates: readonly GateDefinition[],
	request: { readonly cwd: string; readonly signal?: AbortSignal },
): Promise<GateOutcome> => {
	const results: GateResult[] = [];
	let stopped = false;

	for (const gate of gates) {
		if (stopped) {
			results.push({ name: gate.name, status: 'skipped', exitCode: null, log: '' });
			continue;
		}

		const process = await runProcess('bash', ['-c', gate.run], {
			cwd: request.cwd,
			timeoutMs: gate.timeoutMinutes * 60_000,
			removeEnv: CREDENTIAL_VARIABLES,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});

		const passed =
			process.startError === null && process.exitCode === 0 && process.terminatedBy === null;

		results.push({
			name: gate.name,
			status: passed ? 'passed' : 'failed',
			exitCode: process.exitCode,
			log: logOf(gate.run, process),
		});

		if (!passed) stopped = true;
	}

	return { passed: !results.some((result) => result.status !== 'passed'), results };
};

const logOf = (
	command: string,
	process: {
		stdout: string;
		stderr: string;
		exitCode: number;
		terminatedBy: string | null;
		startError: string | null;
	},
): string => {
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
};
