import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { createGitFixture } from '../git/testing/git-fixture.ts';
import { runCli } from './run-cli.ts';

const context = { version: '9.9.9', cwd: process.cwd() };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('the invocation itself', () => {
	test('a bare invocation shows the help and succeeds', async () => {
		const outcome = await runCli([], context);

		expect(outcome.exitCode).toBe(0);
		expect(outcome.stdout).toContain('Usage: docket <command> [options]');
		for (const command of ['changes', 'plan', 'deploy', 'rollback']) {
			expect(outcome.stdout).toContain(command);
		}
	});

	test('--version prints only the version, even with no command', async () => {
		expect(await runCli(['--version'], context)).toEqual({
			stdout: '9.9.9\n',
			stderr: '',
			exitCode: 0,
		});
	});

	test('an unknown command is a usage error, not a failed run', async () => {
		const outcome = await runCli(['frobnicate'], context);

		expect(outcome.exitCode).toBe(2);
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toContain('unknown command: frobnicate');
	});

	test('an unknown option is refused rather than ignored', async () => {
		const outcome = await runCli(['changes', '--nonsense', 'x'], context);

		expect(outcome.exitCode).toBe(2);
		expect(outcome.stderr).toContain('nonsense');
	});

	test('a missing ref stops the run instead of being guessed', async () => {
		const outcome = await runCli(['deploy', '--head', 'a'.repeat(40)], context);

		expect(outcome.exitCode).toBe(2);
		expect(outcome.stderr).toContain('missing required option: --base');
	});

	test('a short SHA is refused: a run is identified by exact commits', async () => {
		const outcome = await runCli(['changes', '--base', 'abc', '--head', 'def'], context);

		expect(outcome.exitCode).toBe(2);
		expect(outcome.stderr).toContain('full 40-character commit SHA');
	});

	/**
	 * A request for JSON is honoured even when the parse itself is what failed,
	 * otherwise `docket --typo --json` answers a machine in prose.
	 */
	test('--json reports a usage error as JSON on stdout', async () => {
		const outcome = await runCli(['deploy', '--json'], context);

		expect(outcome.stderr).toBe('');
		expect(outcome.exitCode).toBe(2);
		expect(JSON.parse(outcome.stdout)).toEqual({
			ok: false,
			error: { code: 'missing_option', message: 'missing required option: --base' },
		});
	});
});

describe('changes', () => {
	test('lists the exact diff, one status per line', async () => {
		const fixture = await createGitFixture({
			base: { 'a.txt': 'one', 'gone.txt': 'x' },
			head: { 'a.txt': 'two', 'new.txt': 'y' },
		});
		cleanups.push(fixture.remove);

		const outcome = await runCli(
			['changes', '--repo', fixture.directory, '--base', fixture.baseSha, '--head', fixture.headSha],
			context,
		);

		expect(outcome.exitCode).toBe(0);
		expect(outcome.stdout).toContain('modified a.txt');
		expect(outcome.stdout).toContain('deleted  gone.txt');
		expect(outcome.stdout).toContain('added    new.txt');
	});

	test('says so plainly when two commits differ in nothing', async () => {
		const fixture = await createGitFixture({ base: { 'a.txt': 'one' }, head: { 'a.txt': 'one' } });
		cleanups.push(fixture.remove);

		const outcome = await runCli(
			['changes', '--repo', fixture.directory, '--base', fixture.baseSha, '--head', fixture.headSha],
			context,
		);

		expect(outcome.stdout).toBe('No changes between the two commits.\n');
	});
});

describe('plan', () => {
	test('writes the manifests a deployment would use, without an org', async () => {
		const config = ['version: 1', 'org: docket-qa', 'allowDestructiveChanges: true', ''].join('\n');
		const classPath = 'force-app/main/default/classes/Greeter.cls';
		const fixture = await createGitFixture({
			base: { 'docket.yml': config, [classPath]: 'public class Greeter {}' },
			head: { 'docket.yml': config },
		});
		cleanups.push(fixture.remove);

		const out = await mkdtemp(join(tmpdir(), 'docket-cli-'));
		cleanups.push(() => rm(out, { recursive: true, force: true }));

		const outcome = await runCli(
			[
				'plan',
				'--repo',
				fixture.directory,
				'--base',
				fixture.baseSha,
				'--head',
				fixture.headSha,
				'--out',
				out,
			],
			context,
		);

		expect(outcome.exitCode).toBe(0);
		expect(outcome.stdout).toContain('Greeter');
		expect(await readFile(join(out, 'destructiveChanges.xml'), 'utf8')).toContain(
			'<members>Greeter</members>',
		);
		expect(await readFile(join(out, 'report.md'), 'utf8')).toContain('## Delete');
	});
});
