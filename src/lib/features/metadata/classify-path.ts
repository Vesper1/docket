import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { MetadataType } from './metadata-component.ts';
import type { MetadataComponent } from './metadata-component.ts';

/**
 * What a repository path means to a deployment.
 *
 * `ignored` is not a weaker form of failure: a README, a workflow file or a
 * test script is legitimately not metadata. The distinction is drawn by
 * location — inside the source directory Docket must understand every path, and
 * outside it Docket must not guess.
 */
export type PathClassification =
	| { readonly kind: 'component'; readonly component: MetadataComponent }
	| { readonly kind: 'ignored' };

export interface ClassifyOptions {
	/** Repository-relative directory holding Salesforce source. */
	readonly sourceRoot: string;
}

/** Salesforce's own default package directory, and the one sfdx scaffolds. */
export const DEFAULT_SOURCE_ROOT = 'force-app';

/**
 * Maps one repository path to the component it defines.
 *
 * Both halves of an Apex class — the body and its `-meta.xml` — map to the same
 * component, so a change to either one deploys the class exactly once.
 */
export function classifyPath(
	path: string,
	options: ClassifyOptions = { sourceRoot: DEFAULT_SOURCE_ROOT },
): Result<PathClassification, DocketError> {
	const root = trimSlashes(options.sourceRoot);
	if (root !== '' && !path.startsWith(`${root}/`)) return ok({ kind: 'ignored' });

	const segments = path.split('/');

	const fileName = segments.at(-1);
	if (fileName === undefined || fileName === '') {
		return err(unsupported(path, 'it does not name a file'));
	}

	const member = apexClassMember(fileName);
	if (member === undefined) {
		return err(unsupported(path, 'only ApexClass is implemented'));
	}

	// Salesforce refuses to deploy a class that is not in a `classes` folder,
	// so a `.cls` found anywhere else is a mistake worth naming now rather than
	// a deployment error twenty minutes later.
	if (segments.at(-2) !== 'classes') {
		return err(unsupported(path, 'an Apex class must live in a `classes` directory'));
	}

	if (!APEX_IDENTIFIER.test(member)) {
		return err(unsupported(path, `\`${member}\` is not a valid Apex class name`));
	}

	return ok({ kind: 'component', component: { type: MetadataType.apexClass, member } });
}

/** Apex class names are Java-like identifiers; anything else never compiled. */
const APEX_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

const APEX_SUFFIXES = ['.cls-meta.xml', '.cls'] as const;

function apexClassMember(fileName: string): string | undefined {
	for (const suffix of APEX_SUFFIXES) {
		if (fileName.endsWith(suffix)) return fileName.slice(0, -suffix.length);
	}

	return undefined;
}

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, '');
}

function unsupported(path: string, reason: string): DocketError {
	return docketError(ErrorCode.unsupportedMetadata, `cannot map \`${path}\`: ${reason}`);
}
