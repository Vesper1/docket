// Categories, not individual rule names: a PMD upgrade that adds a security
// rule should tighten the gate without anyone editing this list. CodeStyle and
// Design are left out on purpose — see code-analyzer.yml. `sfge` and
// `apexguru` are left out because both need a connected org, which a pull
// request gate does not have.
export const defaultRuleSelectors = [
	'pmd:Security',
	'pmd:Performance',
	'pmd:ErrorProne',
	'pmd:BestPractices',
	// Every Flow rule, because the Recommended tag omits MissingFaultHandler,
	// which is the one that turns a Flow error into silent data loss.
	'flow',
	// The whole engine, not its Recommended tag: rules the project turns on in
	// eslint.config.mjs are not all tagged Recommended by Code Analyzer, and a
	// rule the project enabled should never be silently dropped by the gate.
	// Only rules the project config enables can report anything.
	'eslint',
	'regex:Recommended',
	'retire-js:Recommended',
];

// Moderate is where the Apex rules the standalone PMD gate used to enforce sit,
// so nothing that failed before passes now. Low and Info reach the artifact
// without blocking the pull request.
export const defaultSeverityThreshold = '3';

const severityThresholdPattern = /^[1-5]$/u;

export const buildCodeAnalyzerArguments = ({
	files,
	workspace,
	outputFiles,
	ruleSelectors = defaultRuleSelectors,
	severityThreshold = defaultSeverityThreshold,
}) => {
	if (
		typeof severityThreshold !== 'string' ||
		!severityThresholdPattern.test(severityThreshold)
	) {
		throw new TypeError(
			`CODE_ANALYZER_SEVERITY_THRESHOLD must be a severity between 1 and 5, got \`${severityThreshold}\` (${typeof severityThreshold})`,
		);
	}

	return [
		'code-analyzer',
		'run',
		'--workspace',
		workspace,
		// Absolute paths, so a file named `--view` stays a value instead of
		// being parsed as the next flag.
		...files.flatMap((file) => ['--target', file]),
		...ruleSelectors.flatMap((selector) => ['--rule-selector', selector]),
		...outputFiles.flatMap((outputFile) => ['--output-file', outputFile]),
		'--severity-threshold',
		severityThreshold,
		'--view',
		'detail',
	];
};
