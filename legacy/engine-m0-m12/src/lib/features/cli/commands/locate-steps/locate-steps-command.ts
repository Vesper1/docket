import { ok } from '../../../../shared/result/result.ts';
import { findStepCompletionRuns } from '../../../github/checks.ts';
import { readValidatedRun } from '../../../run/read-artifacts.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import { absolutePath } from '../paths.ts';
import { githubClientOf } from '../pipeline-options.ts';

const flags = flagsFor('repository', 'validated-run', 'github-token');

/** Locates the immutable workflow artifact for every required manual step. */
export const locateStepsCommand = defineCommand({
	name: 'locate-steps',
	summary: 'Print workflow runs holding manual-step completions',
	flags,
	run: async (options, context) => {
		const repository = requiredOption(options.repository, '--repository');
		if (!repository.ok) return repository;

		const directory = requiredOption(options['validated-run'], '--validated-run');
		if (!directory.ok) return directory;

		const client = githubClientOf(options, context);
		if (!client.ok) return client;

		const validated = await readValidatedRun(absolutePath(directory.value, context.cwd));
		if (!validated.ok) return validated;

		const manual = validated.value.plan.steps.preDeployment.flatMap((step) =>
			step.kind === 'manual' ? [step.name] : [],
		);
		const origins = await findStepCompletionRuns(client.value, {
			repository: repository.value,
			headSha: validated.value.plan.source.headSha,
			planIdentity: validated.value.plan.identity,
			steps: manual,
		});
		if (!origins.ok) return origins;

		return ok({ kind: 'step-origins', origins: origins.value });
	},
});
