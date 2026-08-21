import { describe, expect, test } from 'vitest';

import { canonicalJsonFile } from '../../shared/json/canonical-json.ts';
import { ErrorCode } from '../../shared/result/docket-error.ts';
import {isOk} from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import type { EnvironmentConfig } from '../config/docket-config.ts';
import type { FileChange } from '../git/file-change.ts';
import { buildPlan, planIdentity } from './build-plan.ts';
import type { PlanIdentityInput, PlanRequest } from './build-plan.ts';
import type { PlanArtifacts } from './deployment-plan.ts';

const CLASSES = 'force-app/main/default/classes';

const QA: EnvironmentConfig = {
	id: 'qa',
	branch: 'main',
	org: 'docket-qa',
	allowDestructiveChanges: false,
	tests: { mode: 'all' },
	gates: [],
	preDeployment: [],
	postDeployment: [],
};

const REQUEST: PlanRequest = {
	source: {
		repository: 'acme/salesforce',
		pullRequest: 42,
		baseSha: 'a'.repeat(40),
		headSha: 'b'.repeat(40),
	},
	environment: QA,
	orgId: '00D000000000001EAA',
	apiVersion: '62.0',
	sourceRoot: 'force-app',
	changes: [{ status: 'added', path: `${CLASSES}/Foo.cls` }],
};

const plan = (overrides: Partial<PlanRequest> = {}): PlanArtifacts => {
	const result = buildPlan({ ...REQUEST, ...overrides });
	if (!isOk(result)) throw new Error(`expected a plan: ${JSON.stringify(result)}`);
	return result.value;
};

describe('a plan combines refs, environment and manifests', () => {
	test('the plan snapshot is exact', () => {
		expect(plan().plan).toEqual({
			schema: 'docket.plan/v1',
			source: {
				repository: 'acme/salesforce',
				pullRequest: 42,
				baseSha: 'a'.repeat(40),
				headSha: 'b'.repeat(40),
			},
			target: { environmentId: 'qa', org: 'docket-qa', orgId: '00D000000000001EAA' },
			tests: { mode: 'all' },
			allowDestructiveChanges: false,
			apiVersion: '62.0',
			components: {
				deployable: [{ type: 'ApexClass', member: 'Foo', change: 'added' }],
				destructive: [],
			},
			steps: { gates: [], preDeployment: [], postDeployment: [] },
			manifestDigests: {
				packageXml: 'sha256:520fda1197a5c4b1cd5a9de38305804649019118d3e09e602e04569551b9fb78',
				destructiveChangesXml: null,
			},
			identity: plan().plan.identity,
		});
	});

	test('the deployable manifest is the one the components describe', () => {
		const artifacts = plan();

		expect(artifacts.packageXml).toContain('<members>Foo</members>');
		expect(artifacts.destructiveChangesXml).toBeUndefined();
	});

	test('a deletion produces a destructive manifest, and only then', () => {
		const artifacts = plan({
			environment: { ...QA, allowDestructiveChanges: true },
			changes: [{ status: 'deleted', path: `${CLASSES}/Old.cls` }],
		});

		expect(artifacts.packageXml).not.toContain('<members>');
		expect(artifacts.destructiveChangesXml).toContain('<members>Old</members>');
		expect(artifacts.plan.manifestDigests.destructiveChangesXml).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe('the validated-plan identity', () => {
	const INPUT: PlanIdentityInput = {
		source: REQUEST.source,
		orgId: REQUEST.orgId,
		tests: { mode: 'all' },
		allowDestructiveChanges: false,
		manifestDigests: { packageXml: 'sha256:aa', destructiveChangesXml: null },
	};

	test('the same tuple always hashes to the same value', () => {
		expect(planIdentity(INPUT)).toBe(planIdentity({ ...INPUT }));
	});

	test('changing any field of the tuple changes the identity', () => {
		const variants: PlanIdentityInput[] = [
			{ ...INPUT, source: { ...INPUT.source, repository: 'acme/other' } },
			{ ...INPUT, source: { ...INPUT.source, pullRequest: 43 } },
			{ ...INPUT, source: { ...INPUT.source, baseSha: 'c'.repeat(40) } },
			{ ...INPUT, source: { ...INPUT.source, headSha: 'd'.repeat(40) } },
			{ ...INPUT, orgId: '00D000000000002EAA' },
			{ ...INPUT, tests: { mode: 'specified', classes: ['FooTest'] } },
			{ ...INPUT, allowDestructiveChanges: true },
			{ ...INPUT, manifestDigests: { packageXml: 'sha256:bb', destructiveChangesXml: null } },
			{ ...INPUT, manifestDigests: { packageXml: 'sha256:aa', destructiveChangesXml: 'sha256:cc' } },
		];

		const identities = new Set(variants.map(planIdentity));

		expect(identities.has(planIdentity(INPUT))).toBe(false);
		expect(identities.size).toBe(variants.length);
	});

	test('a plan carries the identity of its own tuple', () => {
		const artifacts = plan();

		expect(artifacts.plan.identity).toBe(
			planIdentity({
				source: REQUEST.source,
				orgId: REQUEST.orgId,
				tests: QA.tests,
				allowDestructiveChanges: QA.allowDestructiveChanges,
				manifestDigests: artifacts.plan.manifestDigests,
			}),
		);
	});
});

describe('the deletion policy', () => {
	const deletion: FileChange[] = [{ status: 'deleted', path: `${CLASSES}/Old.cls` }];

	test('a deletion fails closed when the environment forbids it', () => {
		const result = buildPlan({ ...REQUEST, changes: deletion });

		expect(errorOf(result).code).toBe(ErrorCode.destructiveNotAllowed);
		expect(errorOf(result).message).toContain('ApexClass:Old');
	});

	test('the same deletion is planned once the environment allows it', () => {
		const artifacts = plan({
			environment: { ...QA, allowDestructiveChanges: true },
			changes: deletion,
		});

		expect(artifacts.plan.components.destructive).toEqual([
			{ type: 'ApexClass', member: 'Old', change: 'deleted' },
		]);
	});

	test('enabling deletion changes the plan identity, so old validation cannot be reused', () => {
		const strict = plan();
		const permissive = plan({ environment: { ...QA, allowDestructiveChanges: true } });

		expect(permissive.plan.identity).not.toBe(strict.plan.identity);
	});
});

describe('the report', () => {
	test('shows added, modified and deleted components and the tests', () => {
		const report = plan({
			environment: { ...QA, allowDestructiveChanges: true, tests: { mode: 'specified', classes: ['FooTest'] } },
			changes: [
				{ status: 'added', path: `${CLASSES}/New.cls` },
				{ status: 'modified', path: `${CLASSES}/Existing.cls` },
				{ status: 'deleted', path: `${CLASSES}/Gone.cls` },
			],
		}).report;

		expect(report).toContain('| ApexClass | New | added |');
		expect(report).toContain('| ApexClass | Existing | modified |');
		expect(report).toContain('| ApexClass | Gone | deleted |');
		expect(report).toContain('| Apex tests | FooTest |');
		expect(report).toContain('| Pull request | #42 |');
	});

	test('says so plainly when a section is empty', () => {
		expect(plan().report).toContain('Nothing is deleted.');
	});
});

describe('artifacts are deterministic', () => {
	test('the same inputs produce byte-identical artifacts', () => {
		const first = plan();
		const second = plan();

		expect(canonicalJsonFile(first.plan)).toBe(canonicalJsonFile(second.plan));
		expect(first.packageXml).toBe(second.packageXml);
		expect(first.report).toBe(second.report);
	});

	test('the order the changes arrive in does not reach the artifacts', () => {
		const changes: FileChange[] = [
			{ status: 'added', path: `${CLASSES}/Zeta.cls` },
			{ status: 'added', path: `${CLASSES}/Alpha.cls` },
		];

		const forward = plan({ changes });
		const reversed = plan({ changes: [...changes].reverse() });

		expect(canonicalJsonFile(forward.plan)).toBe(canonicalJsonFile(reversed.plan));
		expect(forward.plan.identity).toBe(reversed.plan.identity);
	});

	test('the serialized plan sorts its keys', () => {
		const serialized = canonicalJsonFile(plan().plan);

		expect(serialized.indexOf('"allowDestructiveChanges"')).toBeLessThan(
			serialized.indexOf('"apiVersion"'),
		);
	});
});
