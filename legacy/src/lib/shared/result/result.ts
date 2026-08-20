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

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;

export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;
