import type { DocketError } from '../../../shared/result/docket-error.ts';
import { ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import { gateRun } from '../../pipeline/gate-run.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import {
	outputDirectoryOf,
	repositoryDirectoryOf,
	resolveSource,
} from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

/** `docket gates` — the credential-free first half of validation. */
export async function gatesCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
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
}
