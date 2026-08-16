/**
 * One addressable piece of Salesforce metadata.
 *
 * A component, not a file: several files can describe the same component
 * (`Foo.cls` and `Foo.cls-meta.xml`), and it is the component that a manifest
 * lists and that Salesforce deploys or deletes.
 */
export interface MetadataComponent {
	/** A Metadata API type name, spelled exactly as Salesforce spells it. */
	readonly type: MetadataType;
	/** The member name inside that type. */
	readonly member: string;
}

/**
 * The types Docket can build a manifest for. `ApexClass` is the whole MVP
 * (§3, "Delta"); every other type is refused until it is implemented and
 * tested, because a half-known type produces a plan that silently deploys
 * less than the PR contains.
 */
export const MetadataType = {
	apexClass: 'ApexClass',
} as const;

export type MetadataType = (typeof MetadataType)[keyof typeof MetadataType];

/** Identity of a component, for de-duplication across the files that define it. */
export function componentKey(component: MetadataComponent): string {
	return `${component.type}:${component.member}`;
}

/**
 * Total order over components: by type, then by member, both by code unit.
 *
 * `localeCompare` is deliberately avoided — its result depends on the machine's
 * locale and ICU build, and a manifest that reorders itself between a laptop
 * and a runner would break the byte-identical artifacts M4.5 requires.
 */
export function compareComponents(a: MetadataComponent, b: MetadataComponent): number {
	if (a.type !== b.type) return a.type < b.type ? -1 : 1;
	if (a.member === b.member) return 0;
	return a.member < b.member ? -1 : 1;
}
