import { describe, expect, test } from 'vitest';

import { ErrorCode } from '../../shared/result/docket-error.ts';
import {ok} from '../../shared/result/result.ts';
import { errorOf } from '../../shared/result/testing/expect-result.ts';
import type { FileChange } from '../git/file-change.ts';
import { classifyPath } from './classify-path.ts';
import { collectComponents } from './component-set.ts';
import { renderPackageXml } from './package-xml.ts';

const CLASSES = 'force-app/main/default/classes';
const APEX_CLASS = { type: 'ApexClass', member: 'Foo' } as const;

describe('mapping a repository path to a component', () => {
	test('an Apex class body names the class', () => {
		expect(classifyPath(`${CLASSES}/Foo.cls`)).toEqual(
			ok({ kind: 'component', component: APEX_CLASS }),
		);
	});

	test('its metadata file names the same class, so it deploys once', () => {
		expect(classifyPath(`${CLASSES}/Foo.cls-meta.xml`)).toEqual(
			ok({ kind: 'component', component: APEX_CLASS }),
		);
	});

	test('a path outside the source directory is not metadata at all', () => {
		for (const path of ['README.md', '.github/workflows/docket.yml', 'scripts/seed.sh']) {
			expect(classifyPath(path)).toEqual(ok({ kind: 'ignored' }));
		}
	});

	test('the source directory is configurable', () => {
		expect(classifyPath(`${CLASSES}/Foo.cls`, { sourceRoot: 'packages/core' })).toEqual(
			ok({ kind: 'ignored' }),
		);
		expect(
			classifyPath('packages/core/main/default/classes/Foo.cls', { sourceRoot: 'packages/core' }),
		).toEqual(ok({ kind: 'component', component: APEX_CLASS }));
	});

	test('an unimplemented metadata type inside the source directory is refused', () => {
		const result = classifyPath('force-app/main/default/objects/Account/Account.object-meta.xml');

		expect(errorOf(result).code).toBe(ErrorCode.unsupportedMetadata);
	});

	test('an Apex class outside a classes directory is refused', () => {
		const result = classifyPath('force-app/main/default/Foo.cls');

		expect(errorOf(result).code).toBe(ErrorCode.unsupportedMetadata);
	});

	test('a name Apex could never have compiled is refused', () => {
		for (const fileName of ['1Foo.cls', 'Foo-Bar.cls', '.cls']) {
			const result = classifyPath(`${CLASSES}/${fileName}`);

			expect(errorOf(result).code).toBe(ErrorCode.unsupportedMetadata);
		}
	});
});

describe('collecting the components of a change set', () => {
	test('an added class is deployable and nothing is destroyed', () => {
		const result = collectComponents([{ status: 'added', path: `${CLASSES}/Foo.cls` }]);

		expect(result).toEqual(ok({ deployable: [{ ...APEX_CLASS, change: 'added' }], destructive: [] }));
	});

	test('a modified class is listed once, not once per file', () => {
		const result = collectComponents([
			{ status: 'modified', path: `${CLASSES}/Foo.cls` },
			{ status: 'modified', path: `${CLASSES}/Foo.cls-meta.xml` },
		]);

		expect(result).toEqual(
			ok({ deployable: [{ ...APEX_CLASS, change: 'modified' }], destructive: [] }),
		);
	});

	test('files that disagree about one component leave it modified', () => {
		const result = collectComponents([
			{ status: 'modified', path: `${CLASSES}/Foo.cls` },
			{ status: 'added', path: `${CLASSES}/Foo.cls-meta.xml` },
		]);

		expect(result).toEqual(
			ok({ deployable: [{ ...APEX_CLASS, change: 'modified' }], destructive: [] }),
		);
	});

	test('a deleted class is destructive and never deployable', () => {
		const result = collectComponents([
			{ status: 'deleted', path: `${CLASSES}/Foo.cls` },
			{ status: 'deleted', path: `${CLASSES}/Foo.cls-meta.xml` },
		]);

		expect(result).toEqual(
			ok({ deployable: [], destructive: [{ ...APEX_CLASS, change: 'deleted' }] }),
		);
	});

	test('a rename deploys the new class and deletes the old one', () => {
		const result = collectComponents([
			{ status: 'renamed', path: `${CLASSES}/New.cls`, previousPath: `${CLASSES}/Old.cls` },
		]);

		expect(result).toEqual(
			ok({
				deployable: [{ type: 'ApexClass', member: 'New', change: 'added' }],
				destructive: [{ type: 'ApexClass', member: 'Old', change: 'deleted' }],
			}),
		);
	});

	test('a class moved between directories is modified, not deleted and re-added', () => {
		const result = collectComponents([
			{
				status: 'renamed',
				path: `${CLASSES}/Foo.cls`,
				previousPath: 'force-app/main/legacy/classes/Foo.cls',
			},
		]);

		expect(result).toEqual(
			ok({ deployable: [{ ...APEX_CLASS, change: 'modified' }], destructive: [] }),
		);
	});

	test('files that are not metadata do not reach a manifest', () => {
		const result = collectComponents([
			{ status: 'added', path: 'README.md' },
			{ status: 'deleted', path: '.github/workflows/old.yml' },
		]);

		expect(result).toEqual(ok({ deployable: [], destructive: [] }));
	});

	test('an unmappable path fails the whole set instead of shrinking it', () => {
		const result = collectComponents([
			{ status: 'added', path: `${CLASSES}/Foo.cls` },
			{ status: 'added', path: 'force-app/main/default/triggers/AccountTrigger.trigger' },
		]);

		expect(errorOf(result).code).toBe(ErrorCode.unsupportedMetadata);
	});

	test('mixed members come out in a deterministic order', () => {
		const changes: FileChange[] = [
			{ status: 'added', path: `${CLASSES}/Zeta.cls` },
			{ status: 'modified', path: `${CLASSES}/alpha.cls` },
			{ status: 'added', path: `${CLASSES}/Beta.cls` },
		];

		const forward = collectComponents(changes);
		const reversed = collectComponents([...changes].reverse());

		expect(forward).toEqual(reversed);
		expect(forward).toEqual(
			ok({
				deployable: [
					{ type: 'ApexClass', member: 'Beta', change: 'added' },
					{ type: 'ApexClass', member: 'Zeta', change: 'added' },
					{ type: 'ApexClass', member: 'alpha', change: 'modified' },
				],
				destructive: [],
			}),
		);
	});
});

describe('rendering a manifest', () => {
	test('one added class produces the exact expected XML', () => {
		expect(renderPackageXml([APEX_CLASS])).toBe(
			[
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
				'    <types>',
				'        <members>Foo</members>',
				'        <name>ApexClass</name>',
				'    </types>',
				'    <version>62.0</version>',
				'</Package>',
				'',
			].join('\n'),
		);
	});

	test('an empty component set is still a valid manifest', () => {
		expect(renderPackageXml([])).toBe(
			[
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
				'    <version>62.0</version>',
				'</Package>',
				'',
			].join('\n'),
		);
	});

	test('the API version is overridable', () => {
		expect(renderPackageXml([], '64.0')).toContain('<version>64.0</version>');
	});

	test('members are sorted whatever order they arrive in', () => {
		const unsorted = renderPackageXml([
			{ type: 'ApexClass', member: 'Zeta' },
			{ type: 'ApexClass', member: 'Alpha' },
		]);

		expect(unsorted).toBe(
			renderPackageXml([
				{ type: 'ApexClass', member: 'Alpha' },
				{ type: 'ApexClass', member: 'Zeta' },
			]),
		);
		expect(unsorted.indexOf('Alpha')).toBeLessThan(unsorted.indexOf('Zeta'));
	});

	test('repeated renders are byte-identical', () => {
		expect(renderPackageXml([APEX_CLASS])).toBe(renderPackageXml([APEX_CLASS]));
	});
});
