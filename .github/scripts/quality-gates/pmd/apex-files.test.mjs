import assert from 'node:assert/strict';
import test from 'node:test';

import { parseApexFiles } from './apex-files.mjs';

test('rejects line breaks before they can split the PMD file list', () => {
	assert.throws(
		() => parseApexFiles(JSON.stringify(['classes/Bad\nInjected.cls'])),
		/APEX_FILES path contains a line break/,
	);
	assert.throws(
		() => parseApexFiles(JSON.stringify(['classes/Bad\rInjected.cls'])),
		/APEX_FILES path contains a line break/,
	);
});

test('reuses the shared parser and its variable name', () => {
	const files = ['classes/Example.cls', "classes/Odd ; $(false) '.cls"];

	assert.deepEqual(parseApexFiles(JSON.stringify(files)), files);
	assert.throws(() => parseApexFiles(undefined), /APEX_FILES is required/);
});
