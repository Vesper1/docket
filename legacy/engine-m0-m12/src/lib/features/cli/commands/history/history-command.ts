import { ok } from '../../../../shared/result/result.ts';
import { buildDeploymentHistory, writeDeploymentHistory } from '../../../audit/deployment-history.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import { absolutePath } from '../paths.ts';
import { outputDirectoryOf } from '../pipeline-options.ts';

const flags = flagsFor('runs', 'out');

/** `docket history` — one deployment history, rebuilt from verified artifacts. */
export const historyCommand = defineCommand({
	name: 'history',
	summary: 'Build deployment history from verified run artifacts',
	flags,
	run: async (options, context) => {
		const root = requiredOption(options.runs, '--runs');
		if (!root.ok) return root;

		const history = await buildDeploymentHistory(absolutePath(root.value, context.cwd));
		if (!history.ok) return history;

		let outputDirectory: string | null = null;
		if (options.out !== undefined) {
			outputDirectory = outputDirectoryOf(options, context.cwd, 'history');
			const written = await writeDeploymentHistory(outputDirectory, history.value);
			if (!written.ok) return written;
		}

		return ok({ kind: 'history', history: history.value, directory: outputDirectory });
	},
});
