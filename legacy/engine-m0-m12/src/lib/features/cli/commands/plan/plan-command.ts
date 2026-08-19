import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonFile } from '../../../../shared/json/canonical-json.ts';
import { ok } from '../../../../shared/result/result.ts';
import { prepareRun } from '../../../pipeline/prepare.ts';
import { ARTIFACT_NAMES } from '../../../run/write-artifacts.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import {
	orgResolverOf,
	outputDirectoryOf,
	repositoryDirectoryOf,
	resolveSource,
} from '../pipeline-options.ts';

const flags = flagsFor(
	'repo',
	'repository',
	'pull-request',
	'base',
	'head',
	'environment',
	'target-branch',
	'org-id',
	'sf',
	'out',
	'github-token',
);

/**
 * `docket plan` — Phase A and B on their own, with nothing deployed.
 *
 * The plan is the reviewable object: it says which components move, which are
 * deleted and which org they are bound to, before anyone is asked to approve
 * a merge.
 */
export const planCommand = defineCommand({
	name: 'plan',
	summary: 'Build the deployment plan for a pull request',
	flags,
	run: async (options, context) => {
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
			await writePlanArtifacts(
				outputDirectoryOf(options, context.cwd, 'plan'),
				prepared.value.plan,
			);
		}

		return ok({
			kind: 'plan',
			plan: prepared.value.plan.plan,
			report: prepared.value.plan.report,
		});
	},
});

const writePlanArtifacts = async (
	directory: string,
	artifacts: { plan: unknown; packageXml: string; destructiveChangesXml: string | undefined; report: string },
): Promise<void> => {
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
};
