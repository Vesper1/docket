import { compareComponents } from './metadata-component.ts';
import type { MetadataComponent, MetadataType } from './metadata-component.ts';

/**
 * The Metadata API version every manifest is written against.
 *
 * Deliberately not the newest: an org rejects a manifest from the future, and
 * Salesforce supports roughly three years of past versions, so a conservative
 * default is the one that works in every sandbox. `docket.yml` overrides it.
 */
export const DEFAULT_API_VERSION = '62.0';

const INDENT = '    ';

/**
 * Renders a manifest exactly as Salesforce's own tooling shapes it.
 *
 * Nothing in the output depends on a clock, a path or a locale: the same
 * component list always produces the same bytes, which is what lets M4.5
 * compare artifacts across two machines.
 */
export function renderPackageXml(
	components: readonly MetadataComponent[],
	apiVersion: string = DEFAULT_API_VERSION,
): string {
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>', PACKAGE_OPEN];

	for (const [type, members] of groupByType(components)) {
		lines.push(`${INDENT}<types>`);
		for (const member of members) lines.push(`${INDENT}${INDENT}<members>${escape(member)}</members>`);
		lines.push(`${INDENT}${INDENT}<name>${escape(type)}</name>`, `${INDENT}</types>`);
	}

	lines.push(`${INDENT}<version>${escape(apiVersion)}</version>`, '</Package>', '');

	return lines.join('\n');
}

const PACKAGE_OPEN = '<Package xmlns="http://soap.sforce.com/2006/04/metadata">';

/** Types in sorted order, each with its members in sorted order. */
function groupByType(components: readonly MetadataComponent[]): Map<MetadataType, string[]> {
	const grouped = new Map<MetadataType, string[]>();

	for (const component of [...components].sort(compareComponents)) {
		const members = grouped.get(component.type) ?? [];
		members.push(component.member);
		grouped.set(component.type, members);
	}

	return grouped;
}

/**
 * A member name reaches this function from a repository path, so it is not
 * trusted to be XML-safe even though a valid Apex identifier always is.
 */
function escape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}
