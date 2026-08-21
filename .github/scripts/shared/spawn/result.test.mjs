import assert from 'node:assert/strict';
import test from 'node:test';

import { completedStatus } from './result.mjs';

test('reports spawn failures and signal termination', () => {
	const spawnError = new Error('spawn failed');

	assert.throws(
		() => completedStatus({ error: spawnError }, 'Tool'),
		spawnError,
	);
	assert.throws(
		() => completedStatus({ status: null, signal: 'SIGTERM' }, 'Tool'),
		/Tool terminated with signal SIGTERM/,
	);
	assert.equal(completedStatus({ status: 7 }, 'Tool'), 7);
});
