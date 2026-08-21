import { describe, expect, test } from 'vitest';

import { docketError, ErrorCode } from './docket-error.ts';
import { err, isErr, isOk, ok } from './result.ts';
import type { Result } from './result.ts';

describe('Result', () => {
	test('ok carries the value', () => {
		const result = ok(42);

		expect(result.ok).toBe(true);
		expect(result.value).toBe(42);
	});

	test('err carries the error', () => {
		const failure = docketError(ErrorCode.unknownCommand, 'unknown command: nope');
		const result = err(failure);

		expect(result.ok).toBe(false);
		expect(result.error).toBe(failure);
	});

	test('the guards narrow the union', () => {
		const results: Result<number, string>[] = [ok(1), err('boom')];

		const values = results.filter(isOk).map((result) => result.value);
		const errors = results.filter(isErr).map((result) => result.error);

		expect(values).toEqual([1]);
		expect(errors).toEqual(['boom']);
	});
});

describe('error codes are a contract', () => {
	// These literals are what CI scripts and workflow steps branch on. Changing
	// one is a breaking change, so it has to break this test first.
	test('the published codes have their published spellings', () => {
		expect(ErrorCode).toEqual({
			unknownCommand: 'unknown_command',
			invalidOption: 'invalid_option',
			missingOption: 'missing_option',
			gitFailed: 'git_failed',
			unsupportedChange: 'unsupported_change',
			unsupportedMetadata: 'unsupported_metadata',
			invalidConfig: 'invalid_config',
			unknownEnvironment: 'unknown_environment',
			branchMismatch: 'branch_mismatch',
			destructiveNotAllowed: 'destructive_not_allowed',
			salesforceFailed: 'salesforce_failed',
			orgUnavailable: 'org_unavailable',
			orgMismatch: 'org_mismatch',
			secretInArtifact: 'secret_in_artifact',
			planMismatch: 'plan_mismatch',
			validationNotPassed: 'validation_not_passed',
			githubFailed: 'github_failed',
			pullRequestNotEligible: 'pull_request_not_eligible',
			stepIncomplete: 'step_incomplete',
			stepAlreadyCompleted: 'step_already_completed',
			rollbackSourceInvalid: 'rollback_source_invalid',
			rollbackConflict: 'rollback_conflict',
			historyInvalid: 'history_invalid',
		});
	});

	test('a message is human-facing, a code is not', () => {
		const failure = docketError(ErrorCode.invalidOption, "Unknown option '--wat'");

		expect(failure.code).toBe('invalid_option');
		expect(failure.message).toBe("Unknown option '--wat'");
	});
});
