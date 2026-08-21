// Every runner resolves changed files against the checkout, and GitHub Actions
// only guarantees `GITHUB_WORKSPACE` points at it: a step with a
// `working-directory` runs somewhere else entirely.
export const resolveWorkspace = (environment = process.env) =>
	environment.GITHUB_WORKSPACE ?? process.cwd();
