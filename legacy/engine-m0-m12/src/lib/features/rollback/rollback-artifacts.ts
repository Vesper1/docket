import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonFile } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { compareText } from '../../shared/text/compare-text.ts';
import { findSecrets } from '../run/secret-scan.ts';
import type { RollbackProposal } from './rollback-plan.ts';

export const ROLLBACK_ARTIFACT_NAMES = {
	plan: 'rollback-plan.json',
	packageXml: 'package.xml',
	destructiveChangesXml: 'destructiveChanges.xml',
	report: 'report.md',
} as const;

/** Writes a reviewable proposal without ever writing the restored source bytes. */
export const writeRollbackArtifacts = async (
	directory: string,
	proposal: RollbackProposal,
): Promise<Result<readonly string[], DocketError>> => {
	const files = new Map<string, string>([
		[ROLLBACK_ARTIFACT_NAMES.plan, canonicalJsonFile(proposal.plan)],
		[ROLLBACK_ARTIFACT_NAMES.packageXml, proposal.plan.packageXml],
		[ROLLBACK_ARTIFACT_NAMES.report, proposal.report],
	]);
	if (proposal.plan.destructiveChangesXml !== null) {
		files.set(ROLLBACK_ARTIFACT_NAMES.destructiveChangesXml, proposal.plan.destructiveChangesXml);
	}

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

	await mkdir(directory, { recursive: true });
	for (const [name, contents] of files) await writeFile(join(directory, name), contents, 'utf8');
	return ok([...files.keys()].sort(compareText));
};
