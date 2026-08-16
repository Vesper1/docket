import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { canonicalJsonFile } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { PlanArtifacts } from '../plan/deployment-plan.ts';
import type { ValidationRecord } from '../validation/validation-record.ts';
import type { RunRecord } from './run-record.ts';
import { findSecrets } from './secret-scan.ts';

/** A command's captured output, kept beside the run it belongs to. */
export interface LogFile {
	/** File name inside `logs/`. */
	readonly name: string;
	readonly contents: string;
}

export interface RunArtifacts {
	readonly plan: PlanArtifacts;
	readonly validation: ValidationRecord | undefined;
	readonly run: RunRecord;
	readonly logs?: readonly LogFile[];
}

/** The artifact layout of §6, as file names. */
export const ARTIFACT_NAMES = {
	plan: 'plan.json',
	packageXml: 'package.xml',
	destructiveChangesXml: 'destructiveChanges.xml',
	validation: 'validation.json',
	deployment: 'deployment.json',
	run: 'run.json',
	report: 'report.md',
} as const;

/**
 * Writes one run's artifacts and refuses to leave a secret among them.
 *
 * The scan runs before anything reaches disk, not after: an artifact that is
 * written and then found to contain a credential has already been written, and
 * on a runner it may already have been uploaded.
 */
export async function writeRunArtifacts(
	directory: string,
	artifacts: RunArtifacts,
): Promise<Result<readonly string[], DocketError>> {
	const files = new Map<string, string>([
		[ARTIFACT_NAMES.plan, canonicalJsonFile(artifacts.plan.plan)],
		[ARTIFACT_NAMES.packageXml, artifacts.plan.packageXml],
		[ARTIFACT_NAMES.report, artifacts.plan.report],
		[ARTIFACT_NAMES.run, canonicalJsonFile(artifacts.run)],
	]);

	if (artifacts.plan.destructiveChangesXml !== undefined) {
		files.set(ARTIFACT_NAMES.destructiveChangesXml, artifacts.plan.destructiveChangesXml);
	}

	if (artifacts.validation !== undefined) {
		files.set(ARTIFACT_NAMES.validation, canonicalJsonFile(artifacts.validation));
	}

	if (artifacts.run.deployment !== null) {
		files.set(ARTIFACT_NAMES.deployment, canonicalJsonFile(artifacts.run.deployment));
	}

	for (const log of artifacts.logs ?? []) files.set(join('logs', log.name), log.contents);

	const leak = firstSecret(files);
	if (leak !== undefined) return err(leak);

	for (const [name, contents] of files) {
		const target = join(directory, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}

	return ok([...files.keys()].sort());
}

function firstSecret(files: ReadonlyMap<string, string>): DocketError | undefined {
	for (const [name, contents] of files) {
		const findings = findSecrets(contents);
		const first = findings[0];
		if (first === undefined) continue;

		return docketError(
			ErrorCode.secretInArtifact,
			`refusing to write ${name}: it contains a ${first.rule} on line ${first.line}`,
		);
	}

	return undefined;
}
