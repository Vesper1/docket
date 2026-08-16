import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import type { DocketConfig, EnvironmentConfig } from './docket-config.ts';

/**
 * Finds the environment a run was asked for.
 *
 * An unknown id stops the run here, before any command is built: a plan
 * without a target would otherwise have to invent an org, and inventing an org
 * is how metadata reaches the wrong one.
 */
export function selectEnvironment(
	config: DocketConfig,
	id: string,
): Result<EnvironmentConfig, DocketError> {
	const found = config.environments.find((environment) => environment.id === id);
	if (found !== undefined) return ok(found);

	const known = config.environments.map((environment) => environment.id).join(', ');
	return err(
		docketError(ErrorCode.unknownEnvironment, `unknown environment: ${id} (configured: ${known})`),
	);
}

/**
 * Requires the pull request to target the branch this environment deploys.
 *
 * The pairing is the whole safety of a branch-per-environment pipeline: a PR
 * into `main` must not be validated against a production org because someone
 * passed the wrong `--environment`.
 */
export function requireTargetBranch(
	environment: EnvironmentConfig,
	branch: string,
): Result<EnvironmentConfig, DocketError> {
	if (environment.branch === branch) return ok(environment);

	return err(
		docketError(
			ErrorCode.branchMismatch,
			`environment ${environment.id} deploys \`${environment.branch}\`, but the pull request targets \`${branch}\``,
		),
	);
}
