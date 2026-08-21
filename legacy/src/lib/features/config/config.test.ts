import { describe, expect, test } from 'vitest';

import { parseConfig } from './config.ts';

const MINIMAL = ['version: 1', 'org: docket-qa', ''].join('\n');

/** The message matters less than the refusal, so assertions check the code. */
const rejects = (yaml: string): string => {
	const result = parseConfig(yaml);
	expect(result.ok).toBe(false);
	return result.ok ? '' : result.error.code;
};

describe('a minimal file', () => {
	test('needs only a version and an org', () => {
		const result = parseConfig(MINIMAL);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toEqual({
			version: 1,
			sourceRoot: 'force-app',
			org: 'docket-qa',
			tests: { mode: 'all' },
			allowDestructiveChanges: false,
			gates: [],
		});
	});

	/** Deletions fail closed: enabling them has to be a deliberate edit. */
	test('does not permit deletions by default', () => {
		const result = parseConfig(MINIMAL);

		expect(result.ok && result.value.allowDestructiveChanges).toBe(false);
	});
});

describe('what it refuses', () => {
	test('an unknown key, rather than defaulting it away', () => {
		// One letter short of `allowDestructiveChanges` would otherwise read as a
		// silent `false`.
		expect(rejects(`${MINIMAL}allowDestructiveChange: true\n`)).toBe('invalid_config');
	});

	test('a quoted boolean, which is a string and not a policy', () => {
		expect(rejects(`${MINIMAL}allowDestructiveChanges: "true"\n`)).toBe('invalid_config');
	});

	test('a missing org, so no run can guess where to deploy', () => {
		expect(rejects('version: 1\n')).toBe('invalid_config');
	});

	test('a version it does not understand', () => {
		expect(rejects('version: 2\norg: docket-qa\n')).toBe('invalid_config');
	});

	test('an empty test list, which would silently mean every test in the org', () => {
		expect(rejects(`${MINIMAL}tests: []\n`)).toBe('invalid_config');
	});

	test('two gates sharing a name, because a result could not be attributed', () => {
		const duplicated = [
			MINIMAL,
			'gates:',
			'  - name: unit',
			'    run: exit 0',
			'  - name: unit',
			'    run: exit 1',
			'',
		].join('\n');

		expect(rejects(duplicated)).toBe('invalid_config');
	});

	test('a gate with no command to run', () => {
		expect(rejects(`${MINIMAL}gates:\n  - name: unit\n`)).toBe('invalid_config');
	});

	test('text that is not YAML at all', () => {
		expect(rejects('version: 1\n  org: [unclosed\n')).toBe('invalid_config');
	});
});

describe('test selection', () => {
	test('`all` is the default and the word both mean the same thing', () => {
		expect(parseConfig(MINIMAL)).toEqual(parseConfig(`${MINIMAL}tests: all\n`));
	});

	test('an explicit list is kept in the order it was written', () => {
		const result = parseConfig(`${MINIMAL}tests: [BillingTest, GreeterTest]\n`);

		expect(result.ok && result.value.tests).toEqual({
			mode: 'specified',
			classes: ['BillingTest', 'GreeterTest'],
		});
	});
});

describe('gates', () => {
	test('carry a default timeout, so a hanging command cannot run forever', () => {
		const result = parseConfig(`${MINIMAL}gates:\n  - name: unit\n    run: npm test\n`);

		expect(result.ok && result.value.gates).toEqual([
			{ name: 'unit', run: 'npm test', timeoutMinutes: 10 },
		]);
	});

	test('accept an explicit timeout', () => {
		const result = parseConfig(
			`${MINIMAL}gates:\n  - name: unit\n    run: npm test\n    timeoutMinutes: 2\n`,
		);

		expect(result.ok && result.value.gates[0]?.timeoutMinutes).toBe(2);
	});
});
