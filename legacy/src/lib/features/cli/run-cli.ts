import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

import { PRODUCT_NAME } from '../../shared/meta/meta.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { parseCommitSha } from '../git/commit-sha.ts';
import { readChanges } from '../git/read-changes.ts';
import type { FileChange } from '../git/file-change.ts';
import { ARTIFACT_NAMES, preparePlan, runPipeline } from '../pipeline/run-pipeline.ts';
import type { RunOutcome } from '../pipeline/run-pipeline.ts';
import { renderReport } from '../plan/plan.ts';
import { runTestRun } from '../testrun/run-test-run.ts';
import type { TestRunOutcome } from '../testrun/run-test-run.ts';
import type { DeploymentPlan } from '../plan/plan.ts';
import { mkdir, writeFile } from 'node:fs/promises';

export interface CliContext {
	readonly version: string;
	readonly cwd: string;
}

export interface CliOutcome {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: 0 | 1 | 2;
}

/**
 * Every flag the POC takes, declared once.
 *
 * A flag means one thing everywhere: `--head` is always an exact commit,
 * `--out` is always where artifacts land. Which flags a command reads is the
 * only thing that differs.
 */
const OPTIONS = {
	repo: { type: 'string', description: 'Repository to read (default: current directory)' },
	base: { type: 'string', description: 'Full SHA of the base commit' },
	head: { type: 'string', description: 'Full SHA of the head commit' },
	sha: { type: 'string', description: 'Full SHA of the commit naming the org' },
	out: { type: 'string', description: 'Directory for run artifacts' },
	sf: { type: 'string', description: 'Salesforce CLI executable (default: sf)' },
	wait: { type: 'string', description: 'Minutes to wait for Salesforce (default: 33)' },
	'check-only': { type: 'boolean', description: 'Ask Salesforce to check without changing the org' },
	'min-coverage': { type: 'string', description: 'Lowest per-class coverage a test run accepts' },
	json: { type: 'boolean', description: 'Emit machine-readable output on stdout' },
	help: { type: 'boolean', short: 'h', description: 'Show this help' },
	version: { type: 'boolean', short: 'v', description: 'Show the version' },
} as const;

const COMMANDS = {
	changes: 'List the metadata changes between two exact commits',
	plan: 'Write the manifests a deployment would use',
	deploy: 'Deploy the change between two commits to the configured org',
	rollback: 'Deploy the inverse of that change, restoring the base commit',
	test: 'Run every local Apex test in the configured org and report coverage',
} as const;

type CommandName = keyof typeof COMMANDS;

/** Salesforce's own default: half an hour, plus a little. */
const DEFAULT_WAIT_MINUTES = 33;

/**
 * Runs one invocation. It never writes to a stream and never exits, so the
 * entry point owns all process side effects and tests assert exact bytes.
 */
export const runCli = async (argv: readonly string[], context: CliContext): Promise<CliOutcome> => {
	const format = argv.includes('--json') ? 'json' : 'text';
	const result = await execute(argv, context);

	return format === 'json' ? renderJson(result) : renderText(result);
};

type CliData =
	| { readonly kind: 'help'; readonly usage: string }
	| { readonly kind: 'version'; readonly version: string }
	| { readonly kind: 'changes'; readonly changes: readonly FileChange[] }
	| { readonly kind: 'plan'; readonly plan: DeploymentPlan; readonly directory: string }
	| { readonly kind: 'run'; readonly run: RunOutcome }
	| { readonly kind: 'testRun'; readonly run: TestRunOutcome };

const execute = async (
	argv: readonly string[],
	context: CliContext,
): Promise<Result<CliData, DocketError>> => {
	const parsed = parse(argv);
	if (!parsed.ok) return parsed;

	const { command, values } = parsed.value;

	if (values.help === true) return ok({ kind: 'help', usage: helpText() });
	if (values.version === true) return ok({ kind: 'version', version: context.version });
	// A bare invocation is not a mistake; it is someone looking for the help.
	if (command === undefined) return ok({ kind: 'help', usage: helpText() });

	const repositoryDirectory = values.repo ?? context.cwd;

	// The test run takes one commit, not a pair: it deploys nothing, and the
	// only thing it reads from the repository is which org to ask.
	if (command === 'test') {
		const sha = requiredSha(values.sha, '--sha');
		if (!sha.ok) return sha;

		const waitMinutes = waitMinutesOf(values.wait);
		if (!waitMinutes.ok) return waitMinutes;

		const minCoveragePercent = minCoverageOf(values['min-coverage']);
		if (!minCoveragePercent.ok) return minCoveragePercent;

		const run = await runTestRun({
			repositoryDirectory,
			sha: sha.value,
			outputDirectory: outputDirectoryOf(values.out, context.cwd, command),
			executable: values.sf ?? 'sf',
			waitMinutes: waitMinutes.value,
			minCoveragePercent: minCoveragePercent.value,
		});

		return run.ok ? ok({ kind: 'testRun', run: run.value }) : run;
	}

	const base = requiredSha(values.base, '--base');
	if (!base.ok) return base;
	const head = requiredSha(values.head, '--head');
	if (!head.ok) return head;

	if (command === 'changes') {
		const changes = await readChanges({
			cwd: repositoryDirectory,
			baseSha: base.value,
			headSha: head.value,
		});

		return changes.ok ? ok({ kind: 'changes', changes: changes.value }) : changes;
	}

	const directory = outputDirectoryOf(values.out, context.cwd, command);

	if (command === 'plan') {
		const prepared = await preparePlan({
			kind: 'deploy',
			repositoryDirectory,
			baseSha: base.value,
			headSha: head.value,
		});
		if (!prepared.ok) return prepared;

		const written = await writePlan(directory, prepared.value.plan);
		if (!written.ok) return written;

		return ok({ kind: 'plan', plan: prepared.value.plan, directory });
	}

	const waitMinutes = waitMinutesOf(values.wait);
	if (!waitMinutes.ok) return waitMinutes;

	const run = await runPipeline({
		kind: command,
		repositoryDirectory,
		baseSha: base.value,
		headSha: head.value,
		outputDirectory: directory,
		executable: values.sf ?? 'sf',
		waitMinutes: waitMinutes.value,
		checkOnly: values['check-only'] === true,
	});

	return run.ok ? ok({ kind: 'run', run: run.value }) : run;
};

interface Invocation {
	readonly command: CommandName | undefined;
	readonly values: {
		readonly [Name in keyof typeof OPTIONS]?: (typeof OPTIONS)[Name]['type'] extends 'boolean'
			? boolean
			: string;
	};
}

/**
 * The command is the first bare word: `docket <command> [options]`. Anything
 * else positional is a flag someone forgot to name, or a path in the wrong
 * place, and is refused rather than ignored.
 */
const parse = (argv: readonly string[]): Result<Invocation, DocketError> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: Object.fromEntries(
				Object.entries(OPTIONS).map(([name, option]) => [
					name,
					'short' in option ? { type: option.type, short: option.short } : { type: option.type },
				]),
			),
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		// parseArgs appends a paragraph of advice. Keep the diagnosis, drop the lecture.
		const message = error instanceof Error ? error.message : String(error);
		return err(docketError(ErrorCode.invalidOption, message.split('. ')[0] ?? message));
	}

	const [name, extra] = parsed.positionals;
	if (extra !== undefined) {
		return err(docketError(ErrorCode.invalidOption, `unexpected argument: ${extra}`));
	}
	if (name !== undefined && !(name in COMMANDS)) {
		return err(docketError(ErrorCode.unknownCommand, `unknown command: ${name}`));
	}

	return ok({ command: name as CommandName | undefined, values: parsed.values as Invocation['values'] });
};

/**
 * Turns an absent flag into a refusal instead of a default. Guessing a ref is
 * how a run ends up deploying something nobody asked for.
 */
const requiredSha = (value: string | undefined, flag: string): Result<string, DocketError> => {
	if (value === undefined || value === '') {
		return err(docketError(ErrorCode.missingOption, `missing required option: ${flag}`));
	}

	return parseCommitSha(value, flag, ErrorCode.invalidOption);
};

const waitMinutesOf = (value: string | undefined): Result<number, DocketError> => {
	if (value === undefined) return ok(DEFAULT_WAIT_MINUTES);

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return err(docketError(ErrorCode.invalidOption, '--wait must be a positive whole number'));
	}

	return ok(parsed);
};

/**
 * An absent minimum is not zero: it means the run reports coverage without
 * holding anything to a number, which is how a team sees where it stands
 * before deciding what to enforce.
 */
const minCoverageOf = (value: string | undefined): Result<number | null, DocketError> => {
	if (value === undefined) return ok(null);

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
		return err(docketError(ErrorCode.invalidOption, '--min-coverage must be a percentage between 0 and 100'));
	}

	return ok(parsed);
};

const outputDirectoryOf = (out: string | undefined, cwd: string, command: string): string => {
	const directory = out ?? join('.docket', command);
	return isAbsolute(directory) ? directory : join(cwd, directory);
};

const writePlan = async (directory: string, plan: DeploymentPlan): Promise<Result<void, DocketError>> => {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, ARTIFACT_NAMES.packageXml), plan.packageXml, 'utf8');
	if (plan.destructiveChangesXml !== null) {
		await writeFile(
			join(directory, ARTIFACT_NAMES.destructiveChangesXml),
			plan.destructiveChangesXml,
			'utf8',
		);
	}
	await writeFile(join(directory, ARTIFACT_NAMES.report), renderReport(plan), 'utf8');

	return ok(undefined);
};

/**
 * A run that completed but did not pass exits non-zero. The command worked;
 * its subject failed, and nothing downstream may read that as success.
 */
const exitCodeOf = (data: CliData): 0 | 1 =>
	(data.kind === 'run' || data.kind === 'testRun') && data.run.status === 'failed' ? 1 : 0;

const USAGE_EXIT_CODES = new Set<string>([
	ErrorCode.unknownCommand,
	ErrorCode.invalidOption,
	ErrorCode.missingOption,
]);

const exitCodeOfError = (error: DocketError): 1 | 2 => (USAGE_EXIT_CODES.has(error.code) ? 2 : 1);

/**
 * In JSON mode everything goes to stdout, successes and failures alike, so
 * `docket … --json | jq` keeps working on a failing run. The exit code, not
 * the stream, carries the verdict.
 */
const renderJson = (result: Result<CliData, DocketError>): CliOutcome => {
	if (result.ok) {
		return {
			stdout: `${JSON.stringify({ ok: true, data: result.value })}\n`,
			stderr: '',
			exitCode: exitCodeOf(result.value),
		};
	}

	const { code, message } = result.error;
	return {
		stdout: `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
		stderr: '',
		exitCode: exitCodeOfError(result.error),
	};
};

const renderText = (result: Result<CliData, DocketError>): CliOutcome => {
	if (result.ok) {
		return { stdout: humanText(result.value), stderr: '', exitCode: exitCodeOf(result.value) };
	}

	return {
		stdout: '',
		stderr: `${PRODUCT_NAME}: ${result.error.message}\nRun \`${PRODUCT_NAME} --help\` for usage.\n`,
		exitCode: exitCodeOfError(result.error),
	};
};

const humanText = (data: CliData): string => {
	switch (data.kind) {
		case 'help':
			return data.usage;
		case 'version':
			return `${data.version}\n`;
		case 'changes':
			return changeLines(data.changes);
		case 'plan':
			return `${renderReport(data.plan)}artifacts  ${data.directory}\n`;
		case 'run':
			return runSummary(data.run);
		case 'testRun':
			return testRunSummary(data.run);
	}
};

/** One change per line, status first, so `grep deleted` is a useful review. */
const changeLines = (changes: readonly FileChange[]): string => {
	if (changes.length === 0) return 'No changes between the two commits.\n';

	return changes
		.map((change) =>
			change.status === 'renamed'
				? `renamed  ${change.previousPath} -> ${change.path}\n`
				: `${change.status.padEnd(8)} ${change.path}\n`,
		)
		.join('');
};

/**
 * The verdict first, then the reasons. Someone reading a failed run in a
 * terminal needs the failures, not the plan they already approved.
 */
const runSummary = (run: RunOutcome): string => {
	const lines = [
		`${run.kind} ${run.status}: ${run.plan.headSha} -> ${run.plan.org}`,
		`source     ${run.plan.sourceSha}`,
	];

	if (run.deployment !== null) lines.push(`salesforce ${run.deployment.deploymentId}`);
	for (const failure of run.failures) lines.push(`failed     ${failure}`);
	lines.push(`artifacts  ${run.directory}`);

	return `${lines.join('\n')}\n`;
};

/** The verdict, then every reason it is not a pass. */
const testRunSummary = (run: TestRunOutcome): string => {
	const lines = [
		`test ${run.status}: ${run.tests.ran} tests in ${run.org.reference}`,
		`salesforce ${run.tests.testRunId}`,
	];

	for (const failure of run.failures) lines.push(`failed     ${failure}`);
	lines.push(`artifacts  ${run.directory}`);

	return `${lines.join('\n')}\n`;
};

const helpText = (): string => {
	const lines = [
		`${PRODUCT_NAME} — code-first deployment pipelines for Salesforce`,
		'',
		`Usage: ${PRODUCT_NAME} <command> [options]`,
		'',
		'Commands:',
	];

	const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
	for (const [name, summary] of Object.entries(COMMANDS)) {
		lines.push(`  ${name.padEnd(width)}  ${summary}`);
	}

	lines.push('', 'Options:');
	const flagWidth = Math.max(...Object.keys(OPTIONS).map((name) => name.length));
	for (const [name, option] of Object.entries(OPTIONS)) {
		lines.push(`  --${name.padEnd(flagWidth)}  ${option.description}`);
	}
	lines.push('');

	return lines.join('\n');
};
