import { docketError, ErrorCode } from '../../../../shared/result/docket-error.ts';
import { err, ok } from '../../../../shared/result/result.ts';
import { readRecordedRun } from '../../../run/read-artifacts.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import { absolutePath } from '../paths.ts';
import { expectedPlanIdentityOf } from '../pipeline-options.ts';

const flags = flagsFor('run', 'expected-plan-identity');

/** Validates an untrusted run bundle before a workflow reads routing fields from it. */
export const inspectRunCommand = defineCommand({
	name: 'inspect-run',
	summary: 'Verify a run bundle before reading its routing fields',
	flags,
	run: async (options, context) => {
		const directory = requiredOption(options.run, '--run');
		if (!directory.ok) return directory;
		const identity = expectedPlanIdentityOf(options);
		if (!identity.ok) return identity;

		const bundle = absolutePath(directory.value, context.cwd);
		const recorded = await readRecordedRun(bundle);
		if (!recorded.ok) return recorded;
		if (identity.value !== undefined && identity.value !== recorded.value.plan.identity) {
			return err(
				docketError(
					ErrorCode.planMismatch,
					`refusing run: expected ${identity.value}, but the verified bundle is ${recorded.value.plan.identity}`,
				),
			);
		}

		return ok({ kind: 'recorded-run', run: recorded.value.run, directory: bundle });
	},
});
