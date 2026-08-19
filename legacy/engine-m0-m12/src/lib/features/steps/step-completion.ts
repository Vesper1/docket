import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { asRecord } from '../../shared/json/read-json.ts';
import { canonicalJsonFile } from '../../shared/json/canonical-json.ts';
import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';

export const STEP_COMPLETION_SCHEMA = 'docket.step-completion/v1';

/**
 * Evidence that a person carried out a manual step.
 *
 * It names the exact plan it belongs to: a completion recorded against one
 * validated plan must not release a merge for a different one, and a new push
 * produces a new plan identity.
 */
export interface StepCompletion {
	readonly schema: typeof STEP_COMPLETION_SCHEMA;
	readonly step: string;
	readonly planIdentity: string;
	readonly headSha: string;
	readonly completedBy: string;
	/** ISO-8601, supplied by the caller. */
	readonly completedAt: string;
	/** GitHub Actions run that published the immutable artifact, or null locally. */
	readonly workflowRunId: string | null;
}

/**
 * Writes a completion record, once.
 *
 * Immutable by refusal rather than by convention: a second attempt fails
 * instead of overwriting, so "who released this deployment, and when" cannot be
 * rewritten after the fact.
 */
export const recordCompletion = async (
	directory: string,
	completion: StepCompletion,
): Promise<Result<string, DocketError>> => {
	await mkdir(directory, { recursive: true });
	const valid = parseCompletion(completion, fileNameOf(completion));
	if (!valid.ok) return valid;

	const path = completionPath(directory, completion);

	try {
		await writeFile(path, canonicalJsonFile(completion), { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		if (!hasCode(error, 'EEXIST')) throw error;
		return err(
			docketError(
				ErrorCode.stepAlreadyCompleted,
				`step \`${completion.step}\` is already recorded as completed`,
			),
		);
	}

	return ok(path);
};

export const completionPath = (
	directory: string,
	completion: Pick<StepCompletion, 'planIdentity' | 'step'>,
): string => {
	return join(directory, fileNameOf(completion));
};

/** Reads every completion record in a directory, ignoring anything else. */
export const readCompletions = async (
	directory: string,
): Promise<Result<readonly StepCompletion[], DocketError>> => {
	const names = await readdir(directory).catch(() => undefined);
	if (names === undefined) return ok([]);

	const completions: StepCompletion[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith('.json')) continue;

		const contents = await readFile(join(directory, name), 'utf8').catch(() => undefined);
		if (contents === undefined) {
			return err(docketError(ErrorCode.stepIncomplete, `step completion \`${name}\` cannot be read`));
		}

		try {
			const parsed = parseCompletion(JSON.parse(contents), name);
			if (!parsed.ok) return parsed;
			completions.push(parsed.value);
		} catch {
			return err(
				docketError(ErrorCode.stepIncomplete, `step completion \`${name}\` is not readable JSON`),
			);
		}
	}

	return ok(completions);
};

/**
 * Which manual steps of this exact plan are complete.
 *
 * A record for another plan is not counted, and not silently dropped either —
 * it is simply about a different deployment.
 */
export const completedSteps = (
	completions: readonly StepCompletion[],
	planIdentity: string,
	headSha: string,
): ReadonlyMap<string, StepCompletion> => {
	return new Map(
		completions
			.filter(
				(completion) => completion.planIdentity === planIdentity && completion.headSha === headSha,
			)
			.map((completion) => [completion.step, completion]),
	);
};

/** File names have to be safe on every filesystem a runner might use. */
const fileNameOf = (completion: Pick<StepCompletion, 'planIdentity' | 'step'>): string => {
	return `${completion.planIdentity.replace(':', '_')}--${completion.step}.json`;
};

const parseCompletion = (value: unknown, name: string): Result<StepCompletion, DocketError> => {
	const record = asRecord(value);
	const workflowRunId = record?.['workflowRunId'];
	if (
		record?.['schema'] !== STEP_COMPLETION_SCHEMA ||
		!text(record['step'], /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) ||
		!text(record['planIdentity'], /^sha256:[0-9a-f]{64}$/) ||
		!text(record['headSha'], /^[0-9a-f]{40}$/) ||
		!text(record['completedBy'], /^\S(?:.*\S)?$/) ||
		!isoDate(record['completedAt']) ||
		!(workflowRunId === null || text(workflowRunId, /^[1-9][0-9]*$/))
	) {
		return err(
			docketError(ErrorCode.stepIncomplete, `step completion \`${name}\` has an invalid shape`),
		);
	}

	const completion: StepCompletion = {
		schema: STEP_COMPLETION_SCHEMA,
		step: record['step'] as string,
		planIdentity: record['planIdentity'] as string,
		headSha: record['headSha'] as string,
		completedBy: record['completedBy'] as string,
		completedAt: record['completedAt'] as string,
		workflowRunId: workflowRunId as string | null,
	};
	if (fileNameOf(completion) !== name) {
		return err(
			docketError(ErrorCode.stepIncomplete, `step completion \`${name}\` does not match its contents`),
		);
	}

	return ok(completion);
};

const text = (value: unknown, pattern: RegExp): value is string => {
	return typeof value === 'string' && pattern.test(value);
};

const isoDate = (value: unknown): value is string => {
	if (typeof value !== 'string') return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
};

const hasCode = (error: unknown, code: string): boolean => {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
};
