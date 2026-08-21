export const buildPrettierArguments = (files) => [
	'--plugin=prettier-plugin-apex',
	'--check',
	// Changed paths are attacker-controlled through the branch name; after `--`
	// a file called `--write` stays a file instead of becoming a flag.
	'--',
	...files,
];
