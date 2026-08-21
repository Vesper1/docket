import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { asRecord } from '../../shared/json/read-json.ts';
import { canonicalJson, canonicalJsonFile, digestOf } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { CONFIG_FILE_NAME } from '../config/docket-config.ts';
import type { EnvironmentConfig } from '../config/docket-config.ts';
import { parseConfig } from '../config/parse-config.ts';
import { requireTargetBranch, selectEnvironment } from '../config/select-environment.ts';
import { readFileAtCommit } from '../git/read-file.ts';
import { withWorkspace } from '../git/workspace.ts';
import type { PlanSource } from '../plan/deployment-plan.ts';
import { findSecrets } from '../run/secret-scan.ts';
import type { LogFile } from '../run/write-artifacts.ts';
import { runGates } from '../steps/run-steps.ts';
import type { StepRunOutcome } from '../steps/run-steps.ts';
import type { StepResult, Verdict } from '../validation/validation-record.ts';

export const GATE_RUN_SCHEMA = 'docket.gates/v1';
export const GATE_ARTIFACT_NAME = 'gates.json';

/**
 * Credential-free evidence produced before a workflow obtains Salesforce
 * credentials. It is intentionally narrower than a deployment plan: resolving
 * the org belongs to the later validation job.
 */
export interface GateRunRecord {
	readonly schema: typeof GATE_RUN_SCHEMA;
	readonly source: PlanSource;
	readonly environmentId: string;
	readonly targetBranch: string;
	readonly gatesDigest: string;
	readonly status: Verdict;
	readonly results: readonly StepResult[];
}

export interface GateRunRequest {
	readonly repositoryDirectory: string;
	readonly outputDirectory: string;
	readonly source: PlanSource;
	readonly environmentId: string;
	readonly targetBranch: string;
	readonly signal?: AbortSignal;
}

/**
 * Runs candidate gates in the head workspace before any Salesforce
 * authentication exists in the job. Both configuration and the list of
 * commands come from the exact base commit.
 */
export const gateRun = async (request: GateRunRequest): Promise<Result<GateRunRecord, DocketError>> => {
	const environment = await trustedEnvironment(request);
	if (!environment.ok) return environment;

	const outcome = await withWorkspace<StepRunOutcome>(
		{ cwd: request.repositoryDirectory, sha: request.source.headSha },
		async (workspace) =>
			ok(
				await runGates(environment.value.gates, {
				cwd: workspace.directory,
				withoutCredentials: true,
				...(request.signal === undefined ? {} : { signal: request.signal }),
				}),
			),
	);
	if (!outcome.ok) return outcome;

	const record: GateRunRecord = {
		schema: GATE_RUN_SCHEMA,
		source: request.source,
		environmentId: request.environmentId,
		targetBranch: request.targetBranch,
		gatesDigest: gatesDigestOf(environment.value),
		status: outcome.value.results.some((result) => result.status !== 'passed') ? 'failed' : 'passed',
		results: outcome.value.results,
	};

	const written = await writeGateArtifacts(request.outputDirectory, record, outcome.value.logs);
	if (!written.ok) return written;

	return ok(record);
};

/**
 * Verifies the artifact transferred from the credential-free gate job before a
 * credentialed validation trusts it. A failed, stale or edited gate record is
 * never treated as permission to skip candidate checks.
 */
export const readPassedGateRun = async (
	directory: string,
	expected: {
		readonly source: PlanSource;
		readonly environment: EnvironmentConfig;
		readonly targetBranch: string;
	},
): Promise<Result<StepRunOutcome, DocketError>> => {
	const text = await readFile(join(directory, GATE_ARTIFACT_NAME), 'utf8').catch(() => undefined);
	if (text === undefined) return err(invalidGate(`${GATE_ARTIFACT_NAME} is missing`));

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return err(invalidGate(`${GATE_ARTIFACT_NAME} is not readable JSON`));
	}

	const record = asRecord(parsed);
	if (record?.['schema'] !== GATE_RUN_SCHEMA) {
		return err(invalidGate(`${GATE_ARTIFACT_NAME} is not a ${GATE_RUN_SCHEMA} document`));
	}

	if (canonicalJson(record['source']) !== canonicalJson(expected.source)) {
		return err(invalidGate('the gate run belongs to a different repository, pull request or SHA'));
	}
	if (record['environmentId'] !== expected.environment.id || record['targetBranch'] !== expected.targetBranch) {
		return err(invalidGate('the gate run belongs to a different environment or target branch'));
	}
	if (record['gatesDigest'] !== gatesDigestOf(expected.environment)) {
		return err(invalidGate('the configured gates changed after the gate run'));
	}
	if (record['status'] !== 'passed') {
		return err(
			docketError(ErrorCode.validationNotPassed, 'candidate quality gates did not pass in the credential-free job'),
		);
	}

	const results = passedResults(record['results'], expected.environment);
	if (!results.ok) return results;

	const logs: LogFile[] = [];
	for (const gate of expected.environment.gates) {
		const name = `gate-${gate.name}.log`;
		const contents = await readFile(join(directory, 'logs', name), 'utf8').catch(() => undefined);
		if (contents === undefined) return err(invalidGate(`logs/${name} is missing`));
		if (findSecrets(contents).length > 0) {
			return err(invalidGate(`logs/${name} contains credential-shaped text`));
		}
		logs.push({ name, contents });
	}

	return ok({ results: results.value, logs });
};

const gatesDigestOf = (environment: EnvironmentConfig): string => {
	return digestOf(canonicalJson(environment.gates));
};

const trustedEnvironment = async (
	request: Pick<GateRunRequest, 'repositoryDirectory' | 'source' | 'environmentId' | 'targetBranch'>,
): Promise<Result<EnvironmentConfig, DocketError>> => {
	const text = await readFileAtCommit({
		cwd: request.repositoryDirectory,
		sha: request.source.baseSha,
		path: CONFIG_FILE_NAME,
	});
	if (!text.ok) return text;

	const config = parseConfig(text.value);
	if (!config.ok) return config;

	const environment = selectEnvironment(config.value, request.environmentId);
	if (!environment.ok) return environment;

	const branch = requireTargetBranch(environment.value, request.targetBranch);
	return branch.ok ? environment : branch;
};

const writeGateArtifacts = async (
	directory: string,
	record: GateRunRecord,
	logs: readonly LogFile[],
): Promise<Result<readonly string[], DocketError>> => {
	const files = new Map<string, string>([[GATE_ARTIFACT_NAME, canonicalJsonFile(record)]]);
	for (const log of logs) files.set(join('logs', log.name), log.contents);

	for (const [name, contents] of files) {
		const finding = findSecrets(contents)[0];
		if (finding !== undefined) {
			return err(
				docketError(
					ErrorCode.secretInArtifact,
					`refusing to write ${name}: it contains a ${finding.rule} on line ${finding.line}`,
				),
			);
		}
	}

	for (const [name, contents] of files) {
		const target = join(directory, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}

	return ok([...files.keys()].sort());
};

const passedResults = (
	raw: unknown,
	environment: EnvironmentConfig,
): Result<readonly StepResult[], DocketError> => {
	if (!Array.isArray(raw) || raw.length !== environment.gates.length) {
		return err(invalidGate('the recorded gate results do not match the configured gates'));
	}

	const results: StepResult[] = [];
	for (const [index, gate] of environment.gates.entries()) {
		const value = asRecord(raw[index]);
		if (
			value?.['name'] !== gate.name ||
			value['kind'] !== 'gate' ||
			value['manual'] !== false ||
			value['status'] !== 'passed' ||
			value['exitCode'] !== 0 ||
			value['completedBy'] !== null
		) {
			return err(invalidGate(`the recorded result for gate \`${gate.name}\` is not a pass`));
		}

		results.push({
			name: gate.name,
			kind: 'gate',
			manual: false,
			status: 'passed',
			exitCode: 0,
			completedBy: null,
		});
	}

	return ok(results);
};

const invalidGate = (problem: string): DocketError => {
	return docketError(ErrorCode.planMismatch, `refusing to validate: ${problem}`);
};
