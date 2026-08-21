import { join } from 'node:path';

import { runAsEntrypoint } from '../../shared/cli/entrypoint.mjs';
import {
	parseCodeFiles,
	resolveCodeFiles,
} from '../../shared/paths/code-files.mjs';
import { resolveWorkspace } from '../../shared/paths/workspace.mjs';
import { runNodeBinary } from '../../shared/spawn/command.mjs';

import { buildEslintArguments } from './arguments.mjs';

const variableName = 'JS_TS_FILES';
const eslintBinary = join('node_modules', 'eslint', 'bin', 'eslint.js');

export const runEslint = (files, { spawn, workspace = process.cwd() } = {}) =>
	runNodeBinary({
		binary: eslintBinary,
		arguments_: buildEslintArguments(
			resolveCodeFiles(files, { workspace, variableName }),
		),
		label: 'ESLint',
		spawn,
		workspace,
	});

export const main = (environment = process.env, { spawn } = {}) =>
	runEslint(parseCodeFiles(environment[variableName], variableName), {
		spawn,
		workspace: resolveWorkspace(environment),
	});

runAsEntrypoint(import.meta.url, main);
