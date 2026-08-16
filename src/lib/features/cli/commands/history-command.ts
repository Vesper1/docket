import { isAbsolute, join } from 'node:path';

import type { DocketError } from '../../../shared/result/docket-error.ts';
import { ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import {
	buildDeploymentHistory,
	writeDeploymentHistory,
} from '../../audit/deployment-history.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import { outputDirectoryOf } from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

export async function historyCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const root = requiredOption(options.runs, '--runs');
	if (!root.ok) return root;
	const absolute = isAbsolute(root.value) ? root.value : join(context.cwd, root.value);
	const history = await buildDeploymentHistory(absolute);
	if (!history.ok) return history;

	let outputDirectory: string | null = null;
	if (options.out !== undefined) {
		outputDirectory = outputDirectoryOf(options, context.cwd, 'history');
		const written = await writeDeploymentHistory(outputDirectory, history.value);
		if (!written.ok) return written;
	}

	return ok({ kind: 'history', history: history.value, directory: outputDirectory });
}
