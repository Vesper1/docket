import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { GLOBAL_FLAGS } from '../lib/features/cli/commands/command.ts';
import { COMMANDS } from '../lib/features/cli/commands/registry.ts';
import { commandHelpText, helpText } from '../lib/features/cli/help.ts';

/**
 * The structure Docket relies on, asserted rather than remembered.
 *
 * These are the rules the layout exists to enforce: a flag belongs to one
 * command, a fake never reaches production code, and the composition root
 * stays a composition root. A refactor that breaks one of them fails here
 * instead of being noticed a release later.
 */
const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const COMMANDS_DIRECTORY = join(SOURCE, 'lib/features/cli/commands');

describe('the command tree', () => {
	test('every command directory holds exactly one registered command', async () => {
		const directories = await commandDirectories();

		expect(directories).toEqual([...COMMANDS].map((command) => command.name).sort());

		for (const name of directories) {
			const files = await readdir(join(COMMANDS_DIRECTORY, name));
			expect(files).toContain(`${name}-command.ts`);
			expect(files.filter((file) => file.endsWith('-command.ts'))).toHaveLength(1);
		}
	});

	test('a command declares its own flags, and never redefines a global one', () => {
		for (const command of COMMANDS) {
			expect(command.name).toMatch(/^[a-z][a-z0-9-]*$/);
			expect(command.summary).not.toBe('');

			for (const [flag, spec] of Object.entries(command.flags)) {
				expect(flag).toMatch(/^[a-z][a-z0-9-]*$/);
				expect(spec.description).not.toBe('');
				expect(Object.keys(GLOBAL_FLAGS)).not.toContain(flag);
			}
		}
	});

	test('the help is read from the registry, so it cannot go stale', () => {
		const usage = helpText();

		for (const command of COMMANDS) {
			expect(usage).toContain(command.name);
			expect(usage).toContain(command.summary);
		}
	});

	test("a command's help shows its own flags and no others", () => {
		const declared = new Set(COMMANDS.flatMap((command) => Object.keys(command.flags)));

		for (const command of COMMANDS) {
			const usage = commandHelpText(command);

			for (const flag of declared) {
				const shown = new RegExp(`--${flag}\\b`).test(usage);
				expect([flag, shown]).toEqual([flag, flag in command.flags]);
			}
		}
	});

	test('no command imports another command', async () => {
		const directories = await commandDirectories();

		for (const file of await sourceFiles(COMMANDS_DIRECTORY)) {
			const owner = basename(dirname(file));
			// The registry is the one module that is supposed to know them all.
			if (!directories.includes(owner)) continue;

			for (const specifier of await importsOf(file)) {
				const foreign = directories.filter(
					(name) => name !== owner && specifier.includes(`${name}/${name}-command.ts`),
				);
				expect([named(file), foreign]).toEqual([named(file), []]);
			}
		}
	});
});

describe('the dependency direction', () => {
	test('shared knows nothing about features', async () => {
		for (const file of await sourceFiles(join(SOURCE, 'lib/shared'))) {
			for (const specifier of await importsOf(file)) {
				expect([named(file), specifier.includes('features/')]).toEqual([named(file), false]);
			}
		}
	});

	test('production code never imports a test fake', async () => {
		for (const file of await sourceFiles(join(SOURCE, 'lib'))) {
			if (isTestCode(file)) continue;

			for (const specifier of await importsOf(file)) {
				expect([named(file), specifier.includes('/testing/')]).toEqual([named(file), false]);
			}
		}
	});

	test('the entry point only wires the CLI to the process', async () => {
		const entryPoint = join(SOURCE, 'bin/docket.ts');
		const specifiers = (await importsOf(entryPoint)).filter(
			(specifier) => !specifier.startsWith('node:'),
		);

		expect(specifiers).toEqual(['../lib/features/cli/cli.ts']);
	});
});

async function commandDirectories(): Promise<string[]> {
	const entries = await readdir(COMMANDS_DIRECTORY, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/** Every TypeScript file under a root. */
async function sourceFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true, recursive: true });

	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

async function importsOf(file: string): Promise<string[]> {
	const text = await readFile(file, 'utf8');
	return [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
}

/** The path a failure should name: relative to `src`, not to the volume. */
function named(file: string): string {
	return relative(SOURCE, file);
}

function isTestCode(file: string): boolean {
	return file.endsWith('.test.ts') || file.includes('/testing/');
}
