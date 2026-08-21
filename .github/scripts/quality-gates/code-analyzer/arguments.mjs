// The curated PMD set lives behind the `docket-apex` tag in code-analyzer.yml;
// every other engine contributes its own Recommended set. `sfge` and `apexguru`
// are left out on purpose: they need a connected org, which a pull request
// gate does not have.
export const defaultRuleSelectors = [
	'docket-apex',
	'eslint:Recommended',
	'regex:Recommended',
	'flow:Recommended',
	'retire-js:Recommended',
];

// Moderate is the lowest severity in the curated Apex set, so anything the
// standalone PMD gate used to fail on still fails here. Low and Info are
// reported in the artifact without blocking the pull request.
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
