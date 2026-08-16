import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import { isErr, isOk } from '../../shared/result/result.ts';
import { runGates, runSteps } from './run-steps.ts';
import {
	completedSteps,
	readCompletions,
	recordCompletion,
	STEP_COMPLETION_SCHEMA,
} from './step-completion.ts';
import type { StepCompletion } from './step-completion.ts';

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function scratch(): Promise<string> {
	directory = await mkdtemp(join(tmpdir(), 'docket-steps-'));
	return directory;
}

describe('running gates', () => {
	test('a passing gate records its command and result', async () => {
		const outcome = await runGates([{ name: 'lint', run: 'exit 0', timeoutMinutes: 1 }], {
			cwd: await scratch(),
			withoutCredentials: true,
		});

		expect(outcome.results).toEqual([
			{ name: 'lint', kind: 'gate', manual: false, status: 'passed', exitCode: 0, completedBy: null },
		]);
		expect(outcome.logs[0]?.name).toBe('gate-lint.log');
		expect(outcome.logs[0]?.contents).toContain('$ exit 0');
		expect(outcome.logs[0]?.contents).toContain('exit 0');
	});

	test('a failing gate stops the ones after it, and says they were skipped', async () => {
		const outcome = await runGates(
			[
				{ name: 'first', run: 'exit 1', timeoutMinutes: 1 },
				{ name: 'second', run: 'exit 0', timeoutMinutes: 1 },
			],
			{ cwd: await scratch(), withoutCredentials: true },
		);

		expect(outcome.results.map((step) => step.status)).toEqual(['failed', 'skipped']);
	});

	test('a gate that hangs is stopped by its own timeout', async () => {
		const outcome = await runGates([{ name: 'sleeper', run: 'sleep 30', timeoutMinutes: 1 }], {
			cwd: await scratch(),
			withoutCredentials: true,
			signal: AbortSignal.timeout(200),
		});

		expect(outcome.results[0]?.status).toBe('failed');
	});

	test('a gate does not receive the deployment credentials', async () => {
		process.env['SF_AUTH_URL'] = 'force://should-not-be-visible';
		try {
			const outcome = await runGates(
				[{ name: 'peek', run: 'test -z "$SF_AUTH_URL"', timeoutMinutes: 1 }],
				{ cwd: await scratch(), withoutCredentials: true },
			);

			expect(outcome.results[0]?.status).toBe('passed');
		} finally {
			delete process.env['SF_AUTH_URL'];
		}
	});

	test('a gate does not receive the runner tokens either', async () => {
		process.env['ACTIONS_RUNTIME_TOKEN'] = 'artifact-write';
		process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'oidc-mint';
		try {
			const outcome = await runGates(
				[
					{
						name: 'peek',
						run: 'test -z "$ACTIONS_RUNTIME_TOKEN" && test -z "$ACTIONS_ID_TOKEN_REQUEST_TOKEN"',
						timeoutMinutes: 1,
					},
				],
				{ cwd: await scratch(), withoutCredentials: true },
			);

			expect(outcome.results[0]?.status).toBe('passed');
		} finally {
			delete process.env['ACTIONS_RUNTIME_TOKEN'];
			delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
		}
	});

	test('a deployment hook does receive them', async () => {
		process.env['SF_AUTH_URL'] = 'force://visible-to-a-trusted-hook';
		try {
			const outcome = await runSteps(
				[{ kind: 'automatic', name: 'deploy-hook', run: 'test -n "$SF_AUTH_URL"', timeoutMinutes: 1 }],
				{ cwd: await scratch(), kind: 'pre', withoutCredentials: false },
			);

			expect(outcome.results[0]?.status).toBe('passed');
		} finally {
			delete process.env['SF_AUTH_URL'];
		}
	});
});

describe('manual steps', () => {
	const RELEASE_WINDOW = {
		kind: 'manual',
		name: 'release-window',
		instructions: 'Confirm the window',
	} as const;

	test('an uncompleted manual step is pending, and blocks what follows', async () => {
		const outcome = await runSteps(
			[RELEASE_WINDOW, { kind: 'automatic', name: 'announce', run: 'exit 0', timeoutMinutes: 1 }],
			{ cwd: await scratch(), kind: 'pre', withoutCredentials: false, completed: new Set() },
		);

		expect(outcome.results.map((step) => step.status)).toEqual(['pending', 'skipped']);
	});

	test('a completed manual step lets the run continue, and names who did it', async () => {
		const outcome = await runSteps(
			[RELEASE_WINDOW, { kind: 'automatic', name: 'announce', run: 'exit 0', timeoutMinutes: 1 }],
			{
				cwd: await scratch(),
				kind: 'pre',
				withoutCredentials: false,
				completed: new Set(['release-window']),
				completedBy: new Map([['release-window', 'taras']]),
			},
		);

		expect(outcome.results.map((step) => step.status)).toEqual(['passed', 'passed']);
		expect(outcome.results[0]?.completedBy).toBe('taras');
	});
});

describe('completion records', () => {
	const COMPLETION: StepCompletion = {
		schema: STEP_COMPLETION_SCHEMA,
		step: 'release-window',
		planIdentity: `sha256:${'a'.repeat(64)}`,
		headSha: 'b'.repeat(40),
		completedBy: 'taras',
		completedAt: '2026-08-16T10:00:00.000Z',
		workflowRunId: null,
	};

	test('a record is written once and can be read back', async () => {
		const where = await scratch();

		const written = await recordCompletion(where, COMPLETION);
		expect(isOk(written)).toBe(true);

		const read = await readCompletions(where);
		expect(isOk(read) && read.value).toEqual([COMPLETION]);
	});

	test('completing the same step twice is refused, not silently overwritten', async () => {
		const where = await scratch();
		await recordCompletion(where, COMPLETION);

		const second = await recordCompletion(where, { ...COMPLETION, completedBy: 'someone else' });

		expect(isErr(second) && second.error.code).toBe(ErrorCode.stepAlreadyCompleted);
		const read = await readCompletions(where);
		expect(isOk(read) && read.value[0]?.completedBy).toBe('taras');
	});

	test('a record belongs to one exact plan', async () => {
		const forThisPlan = completedSteps([COMPLETION], COMPLETION.planIdentity, COMPLETION.headSha);
		const forAnother = completedSteps(
			[COMPLETION],
			`sha256:${'b'.repeat(64)}`,
			COMPLETION.headSha,
		);

		expect([...forThisPlan.keys()]).toEqual(['release-window']);
		expect([...forAnother.keys()]).toEqual([]);
	});

	test('the same named step can be completed for a later plan in the same directory', async () => {
		const where = await scratch();
		const first = await recordCompletion(where, COMPLETION);
		const second = await recordCompletion(where, {
			...COMPLETION,
			planIdentity: `sha256:${'b'.repeat(64)}`,
			headSha: 'c'.repeat(40),
		});

		expect(isOk(first)).toBe(true);
		expect(isOk(second)).toBe(true);
		const read = await readCompletions(where);
		expect(isOk(read) && read.value).toHaveLength(2);
	});

	test('a schema label alone cannot make malformed JSON a completion', async () => {
		const where = await scratch();
		const written = await recordCompletion(where, COMPLETION);
		if (!isOk(written)) throw new Error('expected a record');
		await writeFile(written.value, JSON.stringify({ ...COMPLETION, completedBy: 7 }), 'utf8');

		const read = await readCompletions(where);
		expect(isErr(read) && read.error.code).toBe(ErrorCode.stepIncomplete);
	});

	test('a directory with no records is empty, not an error', async () => {
		const read = await readCompletions(join(await scratch(), 'nothing-here'));

		expect(isOk(read) && read.value).toEqual([]);
	});

	test('the record on disk names the step, the plan, the person and the time', async () => {
		const where = await scratch();
		const written = await recordCompletion(where, COMPLETION);
		if (!isOk(written)) throw new Error('expected a record');

		expect(JSON.parse(await readFile(written.value, 'utf8'))).toEqual(COMPLETION);
	});
});
