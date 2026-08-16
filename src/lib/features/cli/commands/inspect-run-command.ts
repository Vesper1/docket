import { isAbsolute, join } from 'node:path';

import { docketError, ErrorCode } from '../../../shared/result/docket-error.ts';
import type { DocketError } from '../../../shared/result/docket-error.ts';
import { err, ok } from '../../../shared/result/result.ts';
import type { Result } from '../../../shared/result/result.ts';
import { readRecordedRun } from '../../run/read-artifacts.ts';
import type { CliData } from '../render.ts';
import { requiredOption } from './option.ts';
import { expectedPlanIdentityOf } from './pipeline-options.ts';
import type { PipelineContext, PipelineOptions } from './pipeline-options.ts';

/** Validates an untrusted run bundle before a workflow reads routing fields from it. */
export async function inspectRunCommand(
	options: PipelineOptions,
	context: PipelineContext,
): Promise<Result<CliData, DocketError>> {
	const directory = requiredOption(options.run, '--run');
	if (!directory.ok) return directory;
	const identity = expectedPlanIdentityOf(options);
	if (!identity.ok) return identity;

	const absolute = isAbsolute(directory.value) ? directory.value : join(context.cwd, directory.value);
	const recorded = await readRecordedRun(absolute);
	if (!recorded.ok) return recorded;
	if (identity.value !== undefined && identity.value !== recorded.value.plan.identity) {
		return err(
			docketError(
				ErrorCode.planMismatch,
				`refusing run: expected ${identity.value}, but the verified bundle is ${recorded.value.plan.identity}`,
			),
		);
	}

	return ok({ kind: 'recorded-run', run: recorded.value.run, directory: absolute });
}
