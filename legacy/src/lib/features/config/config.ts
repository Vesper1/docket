import { parse as parseYaml } from 'yaml';

import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';

/** Where Docket looks for its configuration, at the repository root. */
export const CONFIG_FILE_NAME = 'docket.yml';

/** Salesforce's own default package directory, and the one sfdx scaffolds. */
export const DEFAULT_SOURCE_ROOT = 'force-app';

/** How long a gate may run before Docket stops waiting for it. */
export const DEFAULT_GATE_TIMEOUT_MINUTES = 10;

/**
 * Which Apex tests a deployment runs: everything, or a list someone wrote
 * down deliberately.
 */
export type TestSelection =
	| { readonly mode: 'all' }
	| { readonly mode: 'specified'; readonly classes: readonly string[] };

/**
 * A quality gate: a command the candidate must pass before Salesforce is asked
 * anything. It runs with deployment credentials stripped from the environment.
 */
export interface GateDefinition {
	readonly name: string;
	/** A command line, run through Bash in the candidate workspace. */
	readonly run: string;
	readonly timeoutMinutes: number;
}

/**
 * `docket.yml`, normalized.
 *
 * The POC targets one org, so there is no environment list: the file describes
 * the single target directly. Desired configuration only — nothing here is ever
 * written back.
 */
export interface DocketConfig {
	/** Schema version of the file itself, so a future shape can be detected. */
	readonly version: 1;
	/** Repository-relative directory holding Salesforce source. */
	readonly sourceRoot: string;
	/** A Salesforce org alias or username. Never a credential. */
	readonly org: string;
	readonly tests: TestSelection;
	/** Whether a plan may delete metadata at all. */
	readonly allowDestructiveChanges: boolean;
	readonly gates: readonly GateDefinition[];
}

/**
 * Reads `docket.yml` and refuses anything it cannot fully understand.
 *
 * Every rule fails closed. An unknown key is an error rather than a default,
 * because `allowDestructiveChange: true` — one letter short — would otherwise
 * read as a silent `false`.
 */
export const parseConfig = (text: string): Result<DocketConfig, DocketError> => {
	let raw: unknown;
	try {
		// `uniqueKeys` is on by default, so a duplicated key throws here instead
		// of quietly keeping the last one.
		raw = parseYaml(text);
	} catch (error) {
		return err(invalid(`the file is not valid YAML: ${message(error)}`));
	}

	const root = asRecord(raw);
	if (root === undefined) return err(invalid('the file is not a YAML mapping'));

	const unknown = Object.keys(root).filter((key) => !KNOWN_KEYS.has(key));
	if (unknown.length > 0) {
		return err(invalid(`unknown key(s): ${unknown.sort().join(', ')}`));
	}

	if (root['version'] !== 1) return err(invalid('`version` must be exactly 1'));

	const org = nonEmptyText(root['org']);
	if (org === undefined) return err(invalid('`org` must be a non-empty alias or username'));

	const sourceRoot = root['sourceRoot'] === undefined ? DEFAULT_SOURCE_ROOT : nonEmptyText(root['sourceRoot']);
	if (sourceRoot === undefined) return err(invalid('`sourceRoot` must be a non-empty path'));

	// A real YAML boolean only: `"true"` as a string is a mistake worth naming,
	// not a value to coerce.
	const allowDestructiveChanges = root['allowDestructiveChanges'] ?? false;
	if (typeof allowDestructiveChanges !== 'boolean') {
		return err(invalid('`allowDestructiveChanges` must be a YAML boolean'));
	}

	const tests = parseTests(root['tests']);
	if (!tests.ok) return tests;

	const gates = parseGates(root['gates']);
	if (!gates.ok) return gates;

	return ok({
		version: 1,
		sourceRoot: trimSlashes(sourceRoot),
		org,
		tests: tests.value,
		allowDestructiveChanges,
		gates: gates.value,
	});
};

const KNOWN_KEYS = new Set(['version', 'sourceRoot', 'org', 'tests', 'allowDestructiveChanges', 'gates']);

/**
 * `tests: all`, or an explicit list of Apex class names.
 *
 * An empty list is refused rather than treated as `all`: a deployment that
 * silently runs every test in the org is exactly the surprise this rejects.
 */
const parseTests = (raw: unknown): Result<TestSelection, DocketError> => {
	if (raw === undefined || raw === 'all') return ok({ mode: 'all' });

	if (!Array.isArray(raw)) {
		return err(invalid('`tests` must be `all` or a list of Apex class names'));
	}
	if (raw.length === 0) return err(invalid('`tests` is an empty list; use `all` instead'));

	const classes: string[] = [];
	for (const entry of raw) {
		const className = nonEmptyText(entry);
		if (className === undefined) return err(invalid('every entry of `tests` must be a class name'));
		classes.push(className);
	}

	return ok({ mode: 'specified', classes });
};

const parseGates = (raw: unknown): Result<readonly GateDefinition[], DocketError> => {
	if (raw === undefined) return ok([]);
	if (!Array.isArray(raw)) return err(invalid('`gates` must be a list'));

	const gates: GateDefinition[] = [];
	const seen = new Set<string>();

	for (const entry of raw) {
		const gate = asRecord(entry);
		if (gate === undefined) return err(invalid('every gate must be a mapping'));

		const unknown = Object.keys(gate).filter((key) => !GATE_KEYS.has(key));
		if (unknown.length > 0) {
			return err(invalid(`unknown key(s) in a gate: ${unknown.sort().join(', ')}`));
		}

		const name = nonEmptyText(gate['name']);
		if (name === undefined) return err(invalid('every gate needs a non-empty `name`'));
		if (seen.has(name)) return err(invalid(`two gates are named \`${name}\``));
		seen.add(name);

		const run = nonEmptyText(gate['run']);
		if (run === undefined) return err(invalid(`gate \`${name}\` needs a non-empty \`run\``));

		const timeout = gate['timeoutMinutes'] ?? DEFAULT_GATE_TIMEOUT_MINUTES;
		if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
			return err(invalid(`gate \`${name}\` needs a positive whole \`timeoutMinutes\``));
		}

		gates.push({ name, run, timeoutMinutes: timeout });
	}

	return ok(gates);
};

const GATE_KEYS = new Set(['name', 'run', 'timeoutMinutes']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const nonEmptyText = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

const invalid = (problem: string): DocketError =>
	docketError(ErrorCode.invalidConfig, `${CONFIG_FILE_NAME} is invalid: ${problem}`);

const message = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
