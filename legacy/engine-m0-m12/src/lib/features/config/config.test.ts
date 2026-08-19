import { describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import { isErr, isOk, ok } from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import { parseConfig } from './parse-config.ts';
import { requireTargetBranch, selectEnvironment } from './select-environment.ts';

const QA = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests:
      mode: all
`;

/** Parses config a test already knows is valid, so the test stays readable. */
const config = (text: string) => {
	const result = parseConfig(text);
	if (!isOk(result)) throw new Error(`expected valid config: ${JSON.stringify(result)}`);
	return result.value;
};

const codeOf = (text: string) => {
	const result = parseConfig(text);
	return isErr(result) ? result.error.code : undefined;
};

describe('a QA environment', () => {
	test('normalizes to an exact snapshot', () => {
		expect(parseConfig(QA)).toEqual(
			ok({
				version: 1,
				sourceRoot: 'force-app',
				apiVersion: '62.0',
				environments: [
					{
						id: 'qa',
						branch: 'main',
						org: 'docket-qa',
						allowDestructiveChanges: false,
						tests: { mode: 'all' },
						gates: [],
						preDeployment: [],
						postDeployment: [],
					},
				],
			}),
		);
	});

	test('the source root and API version are overridable', () => {
		const parsed = config(`${QA}\nsourceRoot: packages/core\napiVersion: "64.0"\n`);

		expect(parsed.sourceRoot).toBe('packages/core');
		expect(parsed.apiVersion).toBe('64.0');
	});

	test('environments come out sorted, so the snapshot does not depend on file order', () => {
		const two = config(`
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
  integration:
    branch: develop
    org: docket-int
    allowDestructiveChanges: false
    tests: { mode: all }
`);

		expect(two.environments.map((environment) => environment.id)).toEqual(['integration', 'qa']);
	});

	test('a file that is not a mapping, or has no environments, is refused', () => {
		expect(codeOf('- one\n- two\n')).toBe(ErrorCode.invalidConfig);
		expect(codeOf('version: 1\nenvironments: {}\n')).toBe(ErrorCode.invalidConfig);
		expect(codeOf('version: 2\nenvironments:\n  qa: {}\n')).toBe(ErrorCode.invalidConfig);
		expect(codeOf('version: 1\nenvironments:\n  qa: [oops]\n')).toBe(ErrorCode.invalidConfig);
	});

	test('a missing branch or org is refused, never defaulted', () => {
		expect(
			codeOf(`
version: 1
environments:
  qa:
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
`),
		).toBe(ErrorCode.invalidConfig);
	});

	test('a key Docket does not know is a typo, not an extension point', () => {
		expect(codeOf(`${QA}\nunexpected: true\n`)).toBe(ErrorCode.invalidConfig);
		expect(
			codeOf(`
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChange: false
    tests: { mode: all }
`),
		).toBe(ErrorCode.invalidConfig);
	});
});

describe('the destructive-change policy', () => {
	function policy(value: string) {
		return codeOf(`
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: ${value}
    tests: { mode: all }
`);
	}

	test('real YAML booleans are accepted', () => {
		const enabled = config(`
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: true
    tests: { mode: all }
`);

		expect(enabled.environments[0]?.allowDestructiveChanges).toBe(true);
		expect(policy('false')).toBeUndefined();
	});

	test('anything that merely looks like a boolean is refused', () => {
		for (const value of ['"true"', "'false'", 'yes', 'on', 'Y', '1', '~']) {
			expect(policy(value)).toBe(ErrorCode.invalidConfig);
		}
	});

	test('an absent policy is refused rather than assumed', () => {
		expect(
			codeOf(`
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    tests: { mode: all }
`),
		).toBe(ErrorCode.invalidConfig);
	});
});

describe('test selection', () => {
	function tests(block: string) {
		return `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests:
${block}
`;
	}

	test('all-tests mode parses to the all mode', () => {
		expect(config(tests('      mode: all')).environments[0]?.tests).toEqual({ mode: 'all' });
	});

	test('an explicit list parses in the order it was written', () => {
		const parsed = config(
			tests('      mode: specified\n      classes:\n        - FooTest\n        - BarTest'),
		);

		expect(parsed.environments[0]?.tests).toEqual({
			mode: 'specified',
			classes: ['FooTest', 'BarTest'],
		});
	});

	test('an empty or malformed list fails', () => {
		expect(codeOf(tests('      mode: specified\n      classes: []'))).toBe(ErrorCode.invalidConfig);
		expect(codeOf(tests('      mode: specified'))).toBe(ErrorCode.invalidConfig);
		expect(codeOf(tests('      mode: specified\n      classes: FooTest'))).toBe(
			ErrorCode.invalidConfig,
		);
		expect(codeOf(tests('      mode: specified\n      classes:\n        - 7'))).toBe(
			ErrorCode.invalidConfig,
		);
		expect(codeOf(tests('      mode: everything'))).toBe(ErrorCode.invalidConfig);
	});

	test('a class list under all-tests mode is a contradiction, not a hint', () => {
		expect(codeOf(tests('      mode: all\n      classes: [FooTest]'))).toBe(ErrorCode.invalidConfig);
	});
});

describe('gates and deployment steps', () => {
	const WITH_STEPS = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: eslint
        run: npm run lint
      - name: pmd
        run: ./scripts/pmd.sh
        timeoutMinutes: 20
    preDeployment:
      - name: announce
        run: ./scripts/announce.sh
      - name: release-window
        manual: true
        instructions: Confirm the release window with the team lead
    postDeployment:
      - name: smoke
        run: ./scripts/smoke.sh
`;

	test('gates keep their order, command and timeout', () => {
		const environment = config(WITH_STEPS).environments[0];

		expect(environment?.gates).toEqual([
			{ name: 'eslint', run: 'npm run lint', timeoutMinutes: 10 },
			{ name: 'pmd', run: './scripts/pmd.sh', timeoutMinutes: 20 },
		]);
	});

	test('automatic and manual steps live in one ordered list', () => {
		const environment = config(WITH_STEPS).environments[0];

		expect(environment?.preDeployment).toEqual([
			{ kind: 'automatic', name: 'announce', run: './scripts/announce.sh', timeoutMinutes: 10 },
			{
				kind: 'manual',
				name: 'release-window',
				instructions: 'Confirm the release window with the team lead',
			},
		]);
		expect(environment?.postDeployment).toEqual([
			{ kind: 'automatic', name: 'smoke', run: './scripts/smoke.sh', timeoutMinutes: 10 },
		]);
	});

	test('an environment without steps has empty lists, not undefined ones', () => {
		const environment = config(QA).environments[0];

		expect(environment?.gates).toEqual([]);
		expect(environment?.preDeployment).toEqual([]);
		expect(environment?.postDeployment).toEqual([]);
	});

	test('a step that is neither runnable nor explainable is refused', () => {
		const bare = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    preDeployment:
      - name: mystery
`;
		expect(codeOf(bare)).toBe(ErrorCode.invalidConfig);
	});

	test('a manual step cannot also be a command', () => {
		const both = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    preDeployment:
      - name: mystery
        manual: true
        instructions: do the thing
        run: ./do-the-thing.sh
`;
		expect(codeOf(both)).toBe(ErrorCode.invalidConfig);
	});

	test('a manual post-deployment step is refused until the workflow can resume it safely', () => {
		const post = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    postDeployment:
      - name: verify
        manual: true
        instructions: Verify the deployment
`;
		expect(codeOf(post)).toBe(ErrorCode.invalidConfig);
	});

	test('two steps cannot share a name, because results are recorded by name', () => {
		const clash = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    preDeployment:
      - name: announce
        run: ./a.sh
      - name: announce
        run: ./b.sh
`;
		expect(codeOf(clash)).toBe(ErrorCode.invalidConfig);
	});

	test('two gates cannot share a name, because their logs would overwrite each other', () => {
		const clash = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: lint
        run: npm run lint
      - name: lint
        run: npm run lint:strict
`;
		expect(codeOf(clash)).toBe(ErrorCode.invalidConfig);
	});

	test('gate and step names cannot become paths', () => {
		const unsafe = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: ../../outside
        run: exit 0
`;
		expect(codeOf(unsafe)).toBe(ErrorCode.invalidConfig);
	});

	test('a timeout that is not a positive whole number is refused', () => {
		const bad = `
version: 1
environments:
  qa:
    branch: main
    org: docket-qa
    allowDestructiveChanges: false
    tests: { mode: all }
    gates:
      - name: eslint
        run: npm run lint
        timeoutMinutes: 0
`;
		expect(codeOf(bad)).toBe(ErrorCode.invalidConfig);
	});
});

describe('choosing the environment of a run', () => {
	test('a configured id resolves to its environment', () => {
		const environment = selectEnvironment(config(QA), 'qa');

		expect(isOk(environment) && environment.value.org).toBe('docket-qa');
	});

	test('an unknown id is refused and names what exists', () => {
		const result = selectEnvironment(config(QA), 'prod');

		expect(errorOf(result).code).toBe(ErrorCode.unknownEnvironment);
		expect(errorOf(result).message).toContain('qa');
	});

	test('the pull request must target the branch the environment deploys', () => {
		const environment = config(QA).environments[0];
		if (environment === undefined) throw new Error('fixture has no environment');

		expect(isOk(requireTargetBranch(environment, 'main'))).toBe(true);

		const wrong = requireTargetBranch(environment, 'release/2026-09');
		expect(errorOf(wrong).code).toBe(ErrorCode.branchMismatch);
	});
});
