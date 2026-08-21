import { createHash } from 'node:crypto';

/**
 * JSON with every object key in sorted order.
 *
 * Two runs on two machines must produce the same bytes for the same plan, and
 * `JSON.stringify` preserves insertion order — which depends on the order
 * fields happened to be assigned. Sorting removes that from the contract.
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

/** Pretty form for artifacts a human opens, with the same key ordering. */
export const canonicalJsonFile = (value: unknown): string => {
	return `${JSON.stringify(canonicalize(value), null, '\t')}\n`;
};

/**
 * The content digest Docket identifies artifacts by.
 *
 * SHA-256 hex, prefixed with the algorithm, so a stored digest stays readable
 * if the algorithm ever changes and an old one must still be recognised.
 */
export const digestOf = (content: string): string => {
	return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
};

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== 'object') return value;

	const entries = Object.entries(value as Record<string, unknown>)
		// An absent field and a field set to undefined must serialize the same
		// way, otherwise the digest depends on how the object was built.
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
};
