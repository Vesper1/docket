import type { FileChange } from '../git/file-change.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { classifyPath, DEFAULT_SOURCE_ROOT } from './classify-path.ts';
import type { ClassifyOptions } from './classify-path.ts';
import { compareComponents, componentKey } from './metadata-component.ts';
import type { MetadataComponent } from './metadata-component.ts';

/**
 * What a deployment does to one component.
 *
 * Three outcomes, not four: a rename is a file-level idea, and Salesforce only
 * ever receives a component to deploy or a component to delete. Keeping
 * `renamed` here would push that translation into every later reader.
 */
export type ComponentChange = 'added' | 'modified' | 'deleted';

export interface PlannedComponent extends MetadataComponent {
	readonly change: ComponentChange;
}

/**
 * What a deployment must do, split the way Salesforce splits it: one manifest
 * of components to deploy, one manifest of components to delete.
 */
export interface ComponentSet {
	/** Components that go into `package.xml`. */
	readonly deployable: readonly PlannedComponent[];
	/** Components that go into `destructiveChanges.xml`. */
	readonly destructive: readonly PlannedComponent[];
}

/**
 * Turns exact Git changes into the two component lists of a deployment.
 *
 * A rename is both halves at once: the new path is deployed and the old one is
 * deleted. When both halves name the same component — a class file moved
 * between directories — the deletion is dropped and the component is reported
 * as modified, because deleting and deploying the same component in one run
 * would race and could leave the org without the class.
 */
export function collectComponents(
	changes: readonly FileChange[],
	options: ClassifyOptions = { sourceRoot: DEFAULT_SOURCE_ROOT },
): Result<ComponentSet, DocketError> {
	const deployable = new Map<string, PlannedComponent>();
	const destructive = new Map<string, PlannedComponent>();

	for (const change of changes) {
		const classified = classifyPath(change.path, options);
		if (!classified.ok) return classified;

		if (classified.value.kind === 'component') {
			const component = classified.value.component;
			const target = change.status === 'deleted' ? destructive : deployable;
			// A rename delivers a file to a path that did not have one before.
			const applied = change.status === 'renamed' ? 'added' : change.status;
			target.set(componentKey(component), merge(target.get(componentKey(component)), component, applied));
		}

		if (change.status !== 'renamed') continue;

		const previous = classifyPath(change.previousPath, options);
		if (!previous.ok) return previous;
		if (previous.value.kind === 'component') {
			const component = previous.value.component;
			destructive.set(componentKey(component), merge(destructive.get(componentKey(component)), component, 'deleted'));
		}
	}

	for (const [key, component] of deployable) {
		if (!destructive.delete(key)) continue;
		// The component was moved, not replaced: the org already has it.
		deployable.set(key, { ...component, change: 'modified' });
	}

	return ok({ deployable: sorted(deployable), destructive: sorted(destructive) });
}

/**
 * Several files can describe one component. When they disagree — a body edited
 * while its `-meta.xml` is added — the component as a whole is being updated.
 */
function merge(
	existing: PlannedComponent | undefined,
	component: MetadataComponent,
	change: ComponentChange,
): PlannedComponent {
	if (existing === undefined) return { ...component, change };
	return existing.change === change ? existing : { ...component, change: 'modified' };
}

function sorted(components: Map<string, PlannedComponent>): readonly PlannedComponent[] {
	return [...components.values()].sort(compareComponents);
}
