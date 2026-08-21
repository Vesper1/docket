import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPrettierArguments } from './arguments.mjs';

test('terminates formatter options so paths are never read as flags', () => {
	const specialPath = "/work/special ; $(false) ' [code].ts";

	assert.deepEqual(buildPrettierArguments([specialPath]), [
		'--plugin=prettier-plugin-apex',
		'--check',
		'--',
		specialPath,
	]);
});
