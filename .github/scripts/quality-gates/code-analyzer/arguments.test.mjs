import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildCodeAnalyzerArguments,
	defaultRuleSelectors,
	defaultSeverityThreshold,
} from './arguments.mjs';

test('pairs every target, selector, and output file with its own flag', () => {
	const specialPath = "/work/special ; $(false) ' [code].cls";

	const arguments_ = buildCodeAnalyzerArguments({
		files: [specialPath, '/work/Other.cls'],
		outputFiles: ['/work/results.json'],
		workspace: '/work',
	});

	assert.deepEqual(arguments_.slice(0, 8), [
		'code-analyzer',
		'run',
		'--workspace',
		'/work',
		'--target',
		specialPath,
		'--target',
		'/work/Other.cls',
	]);
	assert.deepEqual(
		arguments_.filter(
			(argument, index) => arguments_[index - 1] === '--rule-selector',
		),
		defaultRuleSelectors,
	);
	assert.deepEqual(arguments_.slice(-6), [
		'--output-file',
		'/work/results.json',
		'--severity-threshold',
		defaultSeverityThreshold,
		'--view',
		'detail',
	]);
});

test('rejects a severity threshold outside the 1 to 5 range', () => {
	for (const severityThreshold of ['0', '6', '', 'high', '3 ', 3]) {
		assert.throws(
			() =>
				buildCodeAnalyzerArguments({
					files: [],
					outputFiles: [],
					severityThreshold,
					workspace: '/work',
				}),
			/CODE_ANALYZER_SEVERITY_THRESHOLD must be a severity between 1 and 5/,
		);
	}
});
