import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, digestOf } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { planIdentity } from '../plan/build-plan.ts';
import { PLAN_SCHEMA } from '../plan/deployment-plan.ts';
import type { DeploymentPlan } from '../plan/deployment-plan.ts';
import { VALIDATION_SCHEMA } from '../validation/validation-record.ts';
import type { ValidationRecord } from '../validation/validation-record.ts';
import { ARTIFACT_NAMES } from './write-artifacts.ts';
import { RUN_SCHEMA } from './run-record.ts';
import type { RunRecord } from './run-record.ts';
import { isDeploymentPlan, isRunRecord, isValidationRecord } from './artifact-codecs.ts';

/** Everything a deployment needs from the run that validated it. */
export interface ValidatedRun {
	readonly run: RunRecord;
	readonly validation: ValidationRecord;
	readonly plan: DeploymentPlan;
	/** Absolute path to the manifest validation used. */
	readonly packageXmlPath: string;
	/** Absolute path to the destructive manifest, when the plan has one. */
	readonly destructiveChangesXmlPath: string | undefined;
}

/**
 * Reads a validation run's artifacts and proves they still describe the same
 * deployment.
 *
 * This is the only thing standing between a merged pull request and an
 * arbitrary deployment: the artifacts arrive from a workflow artifact store,
 * so they are treated as input to be verified, not as Docket's own memory.
 * Every field of the identity tuple is recomputed here — a plan whose SHA,
 * org, tests, deletion policy or manifests were edited no longer hashes to the
 * identity it carries.
 */
export const readValidatedRun = async (directory: string): Promise<Result<ValidatedRun, DocketError>> => {
	const run = await readValidationRun(directory);
	if (!run.ok) return run;

	if (run.value.validation.verdict !== 'passed') {
		return err(
			docketError(
				ErrorCode.validationNotPassed,
				`the recorded validation did not pass: ${run.value.validation.failures.join('; ') || 'no reason recorded'}`,
			),
		);
	}

	return run;
};

/** Reads and verifies a validation run whether its verdict is red or green. */
export const readValidationRun = async (directory: string): Promise<Result<ValidatedRun, DocketError>> => {
	const run = await readRecordedRun(directory);
	if (!run.ok) return run;

	if (run.value.run.kind !== 'validate' || run.value.run.status !== run.value.validation.verdict) {
		return err(tampered(`${ARTIFACT_NAMES.run} is not a consistent validation run`));
	}

	return run;
};

/** Reads the common plan/validation/manifests carried by any recorded run. */
export const readRecordedRun = async (directory: string): Promise<Result<ValidatedRun, DocketError>> => {
	const run = await readJson(directory, ARTIFACT_NAMES.run, RUN_SCHEMA, isRunRecord);
	if (!run.ok) return run;

	const validation = await readJson(
		directory,
		ARTIFACT_NAMES.validation,
		VALIDATION_SCHEMA,
		isValidationRecord,
	);
	if (!validation.ok) return validation;

	const planFile = await readJson(directory, ARTIFACT_NAMES.plan, PLAN_SCHEMA, isDeploymentPlan);
	if (!planFile.ok) return planFile;

	const plan = run.value.plan;
	if (run.value.validation === null || canonicalJson(run.value.validation) !== canonicalJson(validation.value)) {
		return err(tampered(`${ARTIFACT_NAMES.run} and ${ARTIFACT_NAMES.validation} disagree`));
	}
	if (canonicalJson(planFile.value) !== canonicalJson(plan)) {
		return err(tampered(`${ARTIFACT_NAMES.plan} and ${ARTIFACT_NAMES.run} disagree`));
	}

	if (validation.value.planIdentity !== plan.identity) {
		return err(tampered('the validation approved a different plan than the one recorded'));
	}
	if (
		validation.value.org.reference !== plan.target.org ||
		validation.value.org.id !== plan.target.orgId ||
		canonicalJson(validation.value.tests) !== canonicalJson(plan.tests)
	) {
		return err(tampered('the validation names a different org or test selection than the plan'));
	}

	const recomputed = planIdentity({
		source: plan.source,
		orgId: plan.target.orgId,
		tests: plan.tests,
		allowDestructiveChanges: plan.allowDestructiveChanges,
		manifestDigests: plan.manifestDigests,
	});
	if (recomputed !== plan.identity) {
		return err(tampered('the plan does not hash to the identity it carries'));
	}

	const manifests = await verifyManifests(directory, plan);
	if (!manifests.ok) return manifests;

	return ok({
		run: run.value,
		validation: validation.value,
		plan,
		packageXmlPath: manifests.value.packageXmlPath,
		destructiveChangesXmlPath: manifests.value.destructiveChangesXmlPath,
	});
};

const verifyManifests = async (
	directory: string,
	plan: DeploymentPlan,
): Promise<
	Result<{ packageXmlPath: string; destructiveChangesXmlPath: string | undefined }, DocketError>
> => {
	const packageXmlPath = join(directory, ARTIFACT_NAMES.packageXml);
	const packageXml = await readFile(packageXmlPath, 'utf8').catch(() => undefined);
	if (packageXml === undefined) return err(tampered(`${ARTIFACT_NAMES.packageXml} is missing`));
	if (digestOf(packageXml) !== plan.manifestDigests.packageXml) {
		return err(tampered(`${ARTIFACT_NAMES.packageXml} does not match the validated plan`));
	}

	const expected = plan.manifestDigests.destructiveChangesXml;
	if (expected === null) return ok({ packageXmlPath, destructiveChangesXmlPath: undefined });

	const destructiveChangesXmlPath = join(directory, ARTIFACT_NAMES.destructiveChangesXml);
	const destructive = await readFile(destructiveChangesXmlPath, 'utf8').catch(() => undefined);
	if (destructive === undefined) {
		return err(tampered(`${ARTIFACT_NAMES.destructiveChangesXml} is missing`));
	}
	if (digestOf(destructive) !== expected) {
		return err(tampered(`${ARTIFACT_NAMES.destructiveChangesXml} does not match the validated plan`));
	}

	return ok({ packageXmlPath, destructiveChangesXmlPath });
}

const readJson = async <T>(
	directory: string,
	name: string,
	schema: string,
	decode: (value: unknown) => value is T,
): Promise<Result<T, DocketError>> => {
	const contents = await readFile(join(directory, name), 'utf8').catch(() => undefined);
	if (contents === undefined) return err(tampered(`${name} is missing`));

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return err(tampered(`${name} is not readable JSON`));
	}

	if (!decode(parsed)) {
		return err(tampered(`${name} is not a valid ${schema} document`));
	}

	return ok(parsed);
};

const tampered = (problem: string): DocketError => {
	return docketError(ErrorCode.planMismatch, `refusing to deploy: ${problem}`);
};
