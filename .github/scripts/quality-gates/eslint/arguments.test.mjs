import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEslintArguments } from './arguments.mjs';

test('fails on warnings and terminates options so paths are never read as flags', () => {
	const specialPath = "/work/special ; $(false) ' [code].ts";

	assert.deepEqual(buildEslintArguments([specialPath]), [
		'--no-warn-ignored',
		'--max-warnings',
		'0',
		'--',
		specialPath,
	]);
});
