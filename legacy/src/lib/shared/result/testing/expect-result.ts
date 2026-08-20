import type { Result } from '../result.ts';

/**
 * Reading one half of a `Result` in a test.
 *
 * Asserting through `isErr(result) && result.error.code` reports `false` when
 * the call unexpectedly succeeded — the failure names the wrong thing, and the
 * value that came back instead is never shown. These throw at the point the
 * assumption broke, so a test that guessed wrong says which half it got.
 */
export const errorOf = <T, E>(result: Result<T, E>): E => {
	if (result.ok) {
		throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
	}

	return result.error;
};

export const valueOf = <T, E>(result: Result<T, E>): T => {
	if (!result.ok) {
		throw new Error(`expected a value, got ${JSON.stringify(result.error)}`);
	}

	return result.value;
};
