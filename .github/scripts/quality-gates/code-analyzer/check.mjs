import { join } from 'node:path';

import { runAsEntrypoint } from '../../shared/cli/entrypoint.mjs';
import {
	parseCodeFiles,
	resolveCodeFiles,
} from '../../shared/paths/code-files.mjs';
import { resolveWorkspace } from '../../shared/paths/workspace.mjs';
import { runCommand } from '../../shared/spawn/command.mjs';
import {
	buildCodeAnalyzerArguments,
	defaultSeverityThreshold,
} from './arguments.mjs';

const variableName = 'CODE_FILES';
const resultNames = [
	'code-analyzer-results.json',
	'code-analyzer-results.html',
];

export const runCodeAnalyzer = (
	files,
	{ spawn, severityThreshold, workspace = process.cwd() } = {},
) =>
	runCommand({
		command: 'sf',
		arguments_: buildCodeAnalyzerArguments({
			files: resolveCodeFiles(files, { workspace, variableName }),
			outputFiles: resultNames.map((name) => join(workspace, name)),
			severityThreshold,
			workspace,
		}),
		label: 'Code Analyzer',
		spawn,
		workspace,
	});

export const main = (environment = process.env, { spawn } = {}) =>
	runCodeAnalyzer(parseCodeFiles(environment[variableName], variableName), {
		severityThreshold:
			environment.CODE_ANALYZER_SEVERITY_THRESHOLD ?? defaultSeverityThreshold,
		spawn,
		workspace: resolveWorkspace(environment),
	});

runAsEntrypoint(import.meta.url, main);
