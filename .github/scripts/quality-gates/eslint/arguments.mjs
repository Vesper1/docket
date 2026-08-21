export const buildEslintArguments = (files) => [
	// A changed file can sit under an `ignores` pattern; without
	// --no-warn-ignored ESLint warns about it and --max-warnings 0 turns that
	// warning into a false failure.
	'--no-warn-ignored',
	'--max-warnings',
	'0',
	// Changed paths are attacker-controlled through the branch name; after `--`
	// a file called `--fix` stays a file instead of becoming a flag.
	'--',
	...files,
];
