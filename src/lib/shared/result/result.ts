/**
 * An operation that can fail without throwing.
 *
 * Docket reserves exceptions for bugs. Anything a user can legitimately hit —
 * a bad ref, a forbidden deletion, a failing test run — is a value, so it can
 * be carried into JSON output and run artifacts instead of unwinding the stack.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
	readonly ok: true;
	readonly value: T;
}

export interface Err<E> {
	readonly ok: false;
	readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
	return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
	return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
	return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
	return !result.ok;
}
