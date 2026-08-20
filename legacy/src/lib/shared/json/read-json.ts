/**
 * Reading values out of JSON that came from somewhere else — a GitHub
 * response, a Salesforce CLI result, a run artifact. Everything here answers
 * `undefined` rather than throwing: the caller decides what a missing field
 * means, and says so in its own error.
 */

/** Narrows to a plain object. Arrays are not records: indexing one by name hides the mismatch. */
export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** An empty string is treated as absent: no field Docket reads is meaningfully `''`. */
export const nonEmptyText = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;
