import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { runCli } from '../cli/cli.ts';
import { MVP_STATE_AUDIT } from './state-contract.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = join(ROOT, 'src');

describe('M12.4 no-database state contract', () => {
	test('maps every runtime-state capability to Git, GitHub, or run artifacts', () => {
		expect(MVP_STATE_AUDIT.database).toBe('none');
		expect(MVP_STATE_AUDIT.capabilities.map((entry) => entry.capability)).toEqual([
			'configuration',
			'validation-handoff',
			'merge-gate',
			'manual-steps',
			'deployment-lock',
			'deployment-history',
			'rollback',
		]);
		expect(MVP_STATE_AUDIT.limitations).toEqual(
			expect.arrayContaining([
				expect.stringContaining('local CLI'),
				expect.stringContaining('retained'),
				expect.stringContaining('100 pending'),
			]),
		);
	});

	test('has no database package, database import, or DATABASE_URL runtime dependency', async () => {
		const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, unknown>;
			devDependencies?: Record<string, unknown>;
		};
		const packages = Object.keys({
			...packageJson.dependencies,
			...packageJson.devDependencies,
		});
		expect(packages.filter((name) => /sqlite|postgres|^pg$|prisma|drizzle|kysely/i.test(name))).toEqual([]);

		const files = await typescriptFiles(SOURCE);
		const source = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
		expect(source).not.toMatch(/from\s+['"](?:node:sqlite|better-sqlite3|sqlite3|pg|postgres)['"]/);
		expect(source).not.toMatch(/process\.env\[['"]DATABASE_URL['"]\]|process\.env\.DATABASE_URL/);
	});

	test('is inspectable through the CLI without any external service', async () => {
		const outcome = await runCli(['state-audit', '--json'], {
			version: '9.9.9',
			cwd: ROOT,
			env: {},
			now: () => new Date('2026-08-16T10:00:00.000Z'),
		});

		expect(outcome.exitCode).toBe(0);
		expect(JSON.parse(outcome.stdout).data.audit).toMatchObject({
			schema: 'docket.state-audit/v1',
			status: 'passed-with-limitations',
			database: 'none',
		});
	});
});

async function typescriptFiles(directory: string): Promise<readonly string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
		else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
	}
	return files.sort();
}
