import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonFile } from '../../../shared/json/canonical-json.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import { prepareRun } from '../../pipeline/prepare.ts';
import { ARTIFACT_NAMES } from '../../run/write-artifacts.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import {
	orgResolverOf,
	outputDirectoryOf,
	repositoryDirectoryOf,
	resolveSource,
} from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

/**
 * `docket plan` — Phase A and B on their own, with nothing deployed.
 *
 * The plan is the reviewable object: it says which components move, which are
 * deleted and which org they are bound to, before anyone is asked to approve
 * a merge.
 */
export async function planCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const source = await resolveSource(options, context);
	if (!source.ok) return source;

	const environment = requiredOption(options.environment, '--environment');
	if (!environment.ok) return environment;

	const repositoryDirectory = repositoryDirectoryOf(options, context.cwd);

	const prepared = await prepareRun(
		{
			repositoryDirectory,
			source: source.value.source,
			environmentId: environment.value,
			targetBranch: source.value.targetBranch,
		},
		orgResolverOf(options, repositoryDirectory),
	);
	if (!prepared.ok) return prepared;

	// Artifacts are written only when a destination was named: a plan someone
	// is reading should not litter their repository.
	if (options.out !== undefined) {
		await writePlanArtifacts(outputDirectoryOf(options, context.cwd, 'plan'), prepared.value.plan);
	}

	return ok({
		kind: 'plan',
		plan: prepared.value.plan.plan,
		report: prepared.value.plan.report,
	});
}

async function writePlanArtifacts(
	directory: string,
	artifacts: { plan: unknown; packageXml: string; destructiveChangesXml: string | undefined; report: string },
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, ARTIFACT_NAMES.plan), canonicalJsonFile(artifacts.plan), 'utf8');
	await writeFile(join(directory, ARTIFACT_NAMES.packageXml), artifacts.packageXml, 'utf8');
	await writeFile(join(directory, ARTIFACT_NAMES.report), artifacts.report, 'utf8');

	if (artifacts.destructiveChangesXml !== undefined) {
		await writeFile(
			join(directory, ARTIFACT_NAMES.destructiveChangesXml),
			artifacts.destructiveChangesXml,
			'utf8',
		);
	}
}
