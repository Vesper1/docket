/**
 * Names Docket may put into a GitHub API path or a Git ref. Both are checked
 * before a request is built, never after: a name that reaches a path is
 * already known to address one repository and one branch.
 */

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

/** Control characters and the wildcards Git itself refuses in a ref name. */
const REFUSED_IN_BRANCH = /[\u0000-\u0020~^:?*[\\]/;

/** `owner/name`, the only repository spelling the GitHub API accepts. */
export const isRepositoryName = (value: string): boolean => REPOSITORY.test(value);

/** Git check-ref-format rules narrowed to branch names Docket can safely address. */
export const isBranchName = (value: string): boolean =>
	value !== '' &&
	!value.startsWith('-') &&
	!value.startsWith('/') &&
	!value.endsWith('/') &&
	!value.endsWith('.') &&
	!value.endsWith('.lock') &&
	!value.includes('..') &&
	!value.includes('@{') &&
	!value.includes('//') &&
	!REFUSED_IN_BRANCH.test(value);
