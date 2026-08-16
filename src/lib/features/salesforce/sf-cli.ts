import { runProcess } from '../../shared/process/run-process.ts';
import type { TerminationReason } from '../../shared/process/run-process.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';

/** The Salesforce CLI as Docket addresses it. */
export interface SalesforceCli {
	/** Executable to run. Overridden in tests by a fake that needs no org. */
	readonly executable: string;
	/** An sfdx project directory — the CLI refuses to deploy from anywhere else. */
	readonly cwd: string;
	/** Upper bound on one CLI call, so a stuck deployment cannot hold a lock. */
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export const DEFAULT_SF_EXECUTABLE = 'sf';

/**
 * Environment that keeps the CLI's own opinions out of Docket's output.
 *
 * An update banner or a progress bar printed onto stdout would corrupt the
 * JSON body Docket parses, and telemetry has no business in a deployment run.
 */
const ISOLATED_SF_ENV = {
	SF_AUTOUPDATE_DISABLE: 'true',
	SF_SKIP_NEW_VERSION_CHECK: 'true',
	SF_DISABLE_TELEMETRY: 'true',
	SF_USE_PROGRESS_BAR: 'false',
	NO_COLOR: '1',
} as const;

/** What `sf … --json` returns, whatever the subcommand. */
export interface SfEnvelope {
	/** The CLI's own status: 0 on success, non-zero on failure. */
	readonly status: number;
	readonly result: unknown;
	/** Present when the CLI explains a failure. */
	readonly message: string | undefined;
	/** The CLI's error name, e.g. `DeployFailed`. */
	readonly name: string | undefined;
	/** Process exit code, kept because a crashed CLI never writes a status. */
	readonly exitCode: number;
}

/**
 * Runs one Salesforce CLI command and returns its JSON envelope.
 *
 * A failing deployment is not an error here: the CLI exits non-zero and still
 * describes exactly which component or test failed, and that description is
 * the most valuable thing in the run. Only an unreadable answer — no JSON at
 * all, a killed process — is a `salesforce_failed`.
 */
export async function runSf(
	cli: SalesforceCli,
	args: readonly string[],
): Promise<Result<SfEnvelope, DocketError>> {
	const result = await runProcess(cli.executable, [...args, '--json'], {
		cwd: cli.cwd,
		env: ISOLATED_SF_ENV,
		...(cli.timeoutMs === undefined ? {} : { timeoutMs: cli.timeoutMs }),
		...(cli.signal === undefined ? {} : { signal: cli.signal }),
	});

	if (result.startError !== null) {
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				`sf ${args.join(' ')} could not start: ${result.startError}`,
			),
		);
	}

	if (result.terminatedBy !== null) {
		return err(
			docketError(ErrorCode.salesforceFailed, terminationMessage(args, result.terminatedBy)),
		);
	}

	const parsed = parseEnvelope(result.stdout);
	if (parsed === undefined) {
		const detail = firstLine(result.stderr) || firstLine(result.stdout) || 'no output';
		return err(
			docketError(
				ErrorCode.salesforceFailed,
				`sf ${args.join(' ')} produced no JSON (exit ${result.exitCode}): ${detail}`,
			),
		);
	}

	return ok({ ...parsed, exitCode: result.exitCode });
}

function terminationMessage(args: readonly string[], reason: TerminationReason): string {
	const cause = reason === 'timeout' ? 'timed out' : 'was cancelled';
	return `sf ${args.join(' ')} ${cause}; Salesforce may still be processing the request`;
}

/**
 * The CLI is supposed to print one JSON document and nothing else, but a shell
 * profile or a plugin warning can prepend a line. Recover the document rather
 * than lose a whole deployment result to someone's `.zshrc`.
 */
function parseEnvelope(stdout: string): Omit<SfEnvelope, 'exitCode'> | undefined {
	const document = extractJson(stdout);
	if (document === undefined) return undefined;

	const status = typeof document['status'] === 'number' ? document['status'] : undefined;
	if (status === undefined) return undefined;

	return {
		status,
		result: document['result'],
		message: typeof document['message'] === 'string' ? document['message'] : undefined,
		name: typeof document['name'] === 'string' ? document['name'] : undefined,
	};
}

function extractJson(stdout: string): Record<string, unknown> | undefined {
	const start = stdout.indexOf('{');
	const end = stdout.lastIndexOf('}');
	if (start === -1 || end < start) return undefined;

	try {
		const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function firstLine(value: string): string {
	return value.trim().split('\n')[0] ?? '';
}
