import { parse as parseYaml } from 'yaml';

import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import {
	DEFAULT_API_VERSION,
	DEFAULT_SOURCE_ROOT,
	DEFAULT_STEP_TIMEOUT_MINUTES,
} from './docket-config.ts';
import type {
	DocketConfig,
	EnvironmentConfig,
	GateDefinition,
	StepDefinition,
	TestSelection,
} from './docket-config.ts';

/**
 * Reads `docket.yml` and refuses anything it cannot fully understand.
 *
 * Every rule here fails closed. An unknown key is an error rather than a
 * default, because `allowDestructiveChange: true` — one letter short — would
 * otherwise read as a silent `false`, and a misspelled `test:` block would
 * silently run every test in the org.
 */
export const parseConfig = (text: string): Result<DocketConfig, DocketError> => {
	let raw: unknown;
	try {
		// `uniqueKeys` is on by default, so a duplicated environment id throws
		// here instead of quietly keeping the last one.
		raw = parseYaml(text);
	} catch (error) {
		return err(invalid('the file is not valid YAML', message(error)));
	}

	const root = asRecord(raw, 'the file');
	if (!root.ok) return root;

	const unknown = rejectUnknownKeys(root.value, ROOT_KEYS, 'the file');
	if (unknown) return err(unknown);

	if (root.value['version'] !== 1) {
		return err(invalid('`version` must be the number 1', describe(root.value['version'])));
	}

	const sourceRoot = optionalString(root.value, 'sourceRoot', DEFAULT_SOURCE_ROOT);
	if (!sourceRoot.ok) return sourceRoot;

	const apiVersion = optionalString(root.value, 'apiVersion', DEFAULT_API_VERSION);
	if (!apiVersion.ok) return apiVersion;

	const environments = parseEnvironments(root.value['environments']);
	if (!environments.ok) return environments;

	return ok({
		version: 1,
		sourceRoot: sourceRoot.value,
		apiVersion: apiVersion.value,
		environments: environments.value,
	});
};

const ROOT_KEYS = ['version', 'sourceRoot', 'apiVersion', 'environments'];
const ENVIRONMENT_KEYS = [
	'branch',
	'org',
	'allowDestructiveChanges',
	'tests',
	'gates',
	'preDeployment',
	'postDeployment',
];
const GATE_KEYS = ['name', 'run', 'timeoutMinutes'];
const STEP_KEYS = ['name', 'run', 'timeoutMinutes', 'manual', 'instructions'];
const TESTS_KEYS = ['mode', 'classes'];

const parseEnvironments = (raw: unknown): Result<readonly EnvironmentConfig[], DocketError> => {
	const record = asRecord(raw, '`environments`');
	if (!record.ok) return record;

	const ids = Object.keys(record.value).sort();
	if (ids.length === 0) return err(invalid('`environments` must define at least one environment'));

	const environments: EnvironmentConfig[] = [];
	for (const id of ids) {
		const environment = parseEnvironment(id, record.value[id]);
		if (!environment.ok) return environment;
		environments.push(environment.value);
	}

	return ok(environments);
};

const parseEnvironment = (id: string, raw: unknown): Result<EnvironmentConfig, DocketError> => {
	const where = `environment \`${id}\``;

	const record = asRecord(raw, where);
	if (!record.ok) return record;

	const unknown = rejectUnknownKeys(record.value, ENVIRONMENT_KEYS, where);
	if (unknown) return err(unknown);

	const branch = requiredString(record.value, 'branch', where);
	if (!branch.ok) return branch;

	const org = requiredString(record.value, 'org', where);
	if (!org.ok) return org;

	const allowDestructiveChanges = requiredBoolean(record.value, 'allowDestructiveChanges', where);
	if (!allowDestructiveChanges.ok) return allowDestructiveChanges;

	const tests = parseTests(record.value['tests'], where);
	if (!tests.ok) return tests;

	const gates = parseGates(record.value['gates'], where);
	if (!gates.ok) return gates;

	const preDeployment = parseSteps(
		record.value['preDeployment'],
		`\`preDeployment\` of ${where}`,
		true,
	);
	if (!preDeployment.ok) return preDeployment;

	const postDeployment = parseSteps(
		record.value['postDeployment'],
		`\`postDeployment\` of ${where}`,
		false,
	);
	if (!postDeployment.ok) return postDeployment;

	return ok({
		id,
		branch: branch.value,
		org: org.value,
		allowDestructiveChanges: allowDestructiveChanges.value,
		tests: tests.value,
		gates: gates.value,
		preDeployment: preDeployment.value,
		postDeployment: postDeployment.value,
	});
};

const parseGates = (raw: unknown, where: string): Result<readonly GateDefinition[], DocketError> => {
	const entries = asList(raw, `\`gates\` of ${where}`);
	if (!entries.ok) return entries;

	const gates: GateDefinition[] = [];
	for (const entry of entries.value) {
		const record = asRecord(entry, `a gate of ${where}`);
		if (!record.ok) return record;

		const unknown = rejectUnknownKeys(record.value, GATE_KEYS, `a gate of ${where}`);
		if (unknown) return err(unknown);

		const name = requiredString(record.value, 'name', `a gate of ${where}`);
		if (!name.ok) return name;
		const safeName = requireSafeExecutionName(name.value, 'gate', where);
		if (!safeName.ok) return safeName;

		const run = requiredString(record.value, 'run', `gate \`${name.value}\``);
		if (!run.ok) return run;

		const timeoutMinutes = parseTimeout(record.value, `gate \`${name.value}\``);
		if (!timeoutMinutes.ok) return timeoutMinutes;

		gates.push({ name: name.value, run: run.value, timeoutMinutes: timeoutMinutes.value });
	}

	const duplicate = duplicateName(gates);
	if (duplicate !== undefined) {
		return err(invalid(`\`gates\` of ${where} has two gates named \`${duplicate}\``));
	}

	return ok(gates);
};

/**
 * Steps keep the order they are written in: a runbook that reorders itself
 * between two runs is not a runbook.
 */
const parseSteps = (
	raw: unknown,
	where: string,
	allowManual: boolean,
): Result<readonly StepDefinition[], DocketError> => {
	const entries = asList(raw, where);
	if (!entries.ok) return entries;

	const steps: StepDefinition[] = [];
	for (const entry of entries.value) {
		const record = asRecord(entry, `a step of ${where}`);
		if (!record.ok) return record;

		const unknown = rejectUnknownKeys(record.value, STEP_KEYS, `a step of ${where}`);
		if (unknown) return err(unknown);

		const name = requiredString(record.value, 'name', `a step of ${where}`);
		if (!name.ok) return name;
		const safeName = requireSafeExecutionName(name.value, 'step', where);
		if (!safeName.ok) return safeName;

		const manual = record.value['manual'];
		if (manual !== undefined && typeof manual !== 'boolean') {
			return err(invalid(`\`manual\` of step \`${name.value}\` must be true or false`, describe(manual)));
		}

		if (manual === true) {
			if (!allowManual) {
				return err(
					invalid(
						`step \`${name.value}\` is manual, but the MVP supports manual steps only before deployment`,
					),
				);
			}
			if ('run' in record.value) {
				return err(invalid(`step \`${name.value}\` is manual, so it cannot also have \`run\``));
			}

			const instructions = requiredString(record.value, 'instructions', `step \`${name.value}\``);
			if (!instructions.ok) return instructions;

			steps.push({ kind: 'manual', name: name.value, instructions: instructions.value });
			continue;
		}

		const run = requiredString(record.value, 'run', `step \`${name.value}\``);
		if (!run.ok) return run;

		const timeoutMinutes = parseTimeout(record.value, `step \`${name.value}\``);
		if (!timeoutMinutes.ok) return timeoutMinutes;

		steps.push({
			kind: 'automatic',
			name: name.value,
			run: run.value,
			timeoutMinutes: timeoutMinutes.value,
		});
	}

	const duplicate = duplicateName(steps);
	if (duplicate !== undefined) {
		// Step results are recorded by name, so two steps sharing one would
		// overwrite each other's evidence.
		return err(invalid(`${where} has two steps named \`${duplicate}\``));
	}

	return ok(steps);
};

/**
 * Names become both GitHub check names and artifact file names. Keep the
 * accepted alphabet deliberately small so a trusted config cannot accidentally
 * create a path separator, two colliding sanitized names, or an unreadable
 * check context.
 */
const EXECUTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const requireSafeExecutionName = (
	name: string,
	kind: 'gate' | 'step',
	where: string,
): Result<string, DocketError> => {
	if (EXECUTION_NAME.test(name)) return ok(name);

	return err(
		invalid(
			`${kind} name \`${name}\` of ${where} must start with a letter or number and contain at most 64 letters, numbers, dots, underscores or hyphens`,
		),
	);
};

const duplicateName = (entries: readonly { readonly name: string }[]): string | undefined => {
	const names = entries.map((entry) => entry.name);
	return names.find((name, index) => names.indexOf(name) !== index);
};

const parseTimeout = (record: Record<string, unknown>, where: string): Result<number, DocketError> => {
	const value = record['timeoutMinutes'];
	if (value === undefined) return ok(DEFAULT_STEP_TIMEOUT_MINUTES);

	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		return err(invalid(`\`timeoutMinutes\` of ${where} must be a positive whole number`, describe(value)));
	}

	return ok(value);
};

const asList = (raw: unknown, where: string): Result<readonly unknown[], DocketError> => {
	if (raw === undefined) return ok([]);
	if (!Array.isArray(raw)) return err(invalid(`${where} must be a list`, describe(raw)));

	return ok(raw);
};

const parseTests = (raw: unknown, where: string): Result<TestSelection, DocketError> => {
	const record = asRecord(raw, `\`tests\` of ${where}`);
	if (!record.ok) return record;

	const unknown = rejectUnknownKeys(record.value, TESTS_KEYS, `\`tests\` of ${where}`);
	if (unknown) return err(unknown);

	const mode = record.value['mode'];
	if (mode === 'all') {
		if ('classes' in record.value) {
			return err(invalid(`\`tests.classes\` of ${where} is meaningless with mode \`all\``));
		}
		return ok({ mode: 'all' });
	}

	if (mode !== 'specified') {
		return err(invalid(`\`tests.mode\` of ${where} must be \`all\` or \`specified\``, describe(mode)));
	}

	const classes = record.value['classes'];
	if (!Array.isArray(classes) || classes.length === 0) {
		return err(
			invalid(
				`\`tests.classes\` of ${where} must be a non-empty list when mode is \`specified\``,
				describe(classes),
			),
		);
	}

	for (const entry of classes) {
		if (typeof entry !== 'string' || entry.trim() === '') {
			return err(invalid(`\`tests.classes\` of ${where} must contain test class names`, describe(entry)));
		}
	}

	return ok({ mode: 'specified', classes: [...(classes as string[])] });
};

const asRecord = (value: unknown, where: string): Result<Record<string, unknown>, DocketError> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return err(invalid(`${where} must be a mapping`, describe(value)));
	}

	return ok(value as Record<string, unknown>);
};

const requiredString = (
	record: Record<string, unknown>,
	key: string,
	where: string,
): Result<string, DocketError> => {
	const value = record[key];
	if (typeof value !== 'string' || value.trim() === '') {
		return err(invalid(`\`${key}\` of ${where} must be a non-empty string`, describe(value)));
	}

	return ok(value);
};

/**
 * A YAML boolean, never a string that resembles one. `"true"` and the YAML 1.1
 * spellings `yes`/`on` parse as strings under the 1.2 core schema, and a
 * deletion policy is not a place to be generous about what someone meant.
 */
const requiredBoolean = (
	record: Record<string, unknown>,
	key: string,
	where: string,
): Result<boolean, DocketError> => {
	const value = record[key];
	if (typeof value !== 'boolean') {
		return err(invalid(`\`${key}\` of ${where} must be true or false`, describe(value)));
	}

	return ok(value);
};

const optionalString = (
	record: Record<string, unknown>,
	key: string,
	fallback: string,
): Result<string, DocketError> => {
	if (!(key in record)) return ok(fallback);

	return requiredString(record, key, 'the file');
};

const rejectUnknownKeys = (
	record: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
): DocketError | undefined => {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length === 0) return undefined;

	return invalid(`${where} has unknown keys: ${unknown.sort().join(', ')}`);
};

const invalid = (problem: string, found?: string): DocketError => {
	const suffix = found === undefined ? '' : ` (found ${found})`;
	return docketError(ErrorCode.invalidConfig, `docket.yml: ${problem}${suffix}`);
};

/** Names what was actually there, without printing a whole nested document. */
const describe = (value: unknown): string => {
	if (value === undefined) return 'nothing';
	if (value === null) return 'null';
	if (Array.isArray(value)) return `a list of ${value.length}`;
	if (typeof value === 'object') return 'a mapping';
	return `${typeof value} ${JSON.stringify(value)}`;
};

const message = (error: unknown): string => {
	return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
};
