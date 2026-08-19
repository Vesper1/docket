import { ok } from '../../../../shared/result/result.ts';
import { gateRun } from '../../../pipeline/gate-run.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import { outputDirectoryOf, repositoryDirectoryOf, resolveSource } from '../pipeline-options.ts';

const flags = flagsFor(
	'repo',
	'repository',
	'pull-request',
	'base',
	'head',
	'environment',
	'target-branch',
	'out',
	'github-token',
);

/** `docket gates` — the credential-free first half of validation. */
export const gatesCommand = defineCommand({
	name: 'gates',
	summary: 'Run candidate quality gates without deployment credentials',
	flags,
	run: async (options, context) => {
		const source = await resolveSource(options, context);
		if (!source.ok) return source;

		const environment = requiredOption(options.environment, '--environment');
		if (!environment.ok) return environment;

		const targetBranch = requiredOption(source.value.targetBranch, '--target-branch');
		if (!targetBranch.ok) return targetBranch;

		const outputDirectory = outputDirectoryOf(options, context.cwd, 'gates');
		const run = await gateRun({
			repositoryDirectory: repositoryDirectoryOf(options, context.cwd),
			outputDirectory,
			source: source.value.source,
			environmentId: environment.value,
			targetBranch: targetBranch.value,
		});
		if (!run.ok) return run;

		return ok({ kind: 'gate-run', run: run.value, directory: outputDirectory });
	},
});
