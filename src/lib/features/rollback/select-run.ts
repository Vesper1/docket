import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { RunRecord } from '../run/run-record.ts';
import { readRecordedRun } from '../run/read-artifacts.ts';
import { ARTIFACT_NAMES } from '../run/write-artifacts.ts';

/** M11.1: a deployment run that is safe to use as rollback input. */
export async function selectRollbackSource(
	directory: string,
): Promise<Result<RunRecord, DocketError>> {
	const recorded = await readRecordedRun(directory);
	if (!recorded.ok) return recorded;

	const run = recorded.value.run;
	if (run.kind !== 'deploy' && run.kind !== 'rollback') {
		return err(invalid(`run kind \`${run.kind}\` did not change an org`));
	}
	if (run.status !== 'passed') {
		return err(invalid(`run status is \`${run.status}\`, not \`passed\``));
	}
	if (
		run.deployment === null ||
		run.deployment.success !== true ||
		run.deployment.checkOnly !== false ||
		typeof run.deployment.deploymentId !== 'string' ||
		run.deployment.deploymentId === ''
	) {
		return err(invalid('run has no successful regular Salesforce deployment'));
	}

	const deploymentFile = await readFile(join(directory, ARTIFACT_NAMES.deployment), 'utf8').catch(
		() => undefined,
	);
	if (deploymentFile === undefined) return err(invalid(`${ARTIFACT_NAMES.deployment} is missing`));

	let deployment: unknown;
	try {
		deployment = JSON.parse(deploymentFile);
	} catch {
		return err(invalid(`${ARTIFACT_NAMES.deployment} is not readable JSON`));
	}
	if (canonicalJson(deployment) !== canonicalJson(run.deployment)) {
		return err(invalid(`${ARTIFACT_NAMES.deployment} and ${ARTIFACT_NAMES.run} disagree`));
	}

	return ok(run);
}

function invalid(problem: string): DocketError {
	return docketError(ErrorCode.rollbackSourceInvalid, `cannot start rollback: ${problem}`);
}
