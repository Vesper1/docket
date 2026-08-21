import { join } from 'node:path';

import { runAsEntrypoint } from '../../shared/cli/entrypoint.mjs';
import {
	parseCodeFiles,
	resolveCodeFiles,
} from '../../shared/paths/code-files.mjs';
import { resolveWorkspace } from '../../shared/paths/workspace.mjs';
import { runNodeBinary } from '../../shared/spawn/command.mjs';
import { buildPrettierArguments } from './arguments.mjs';

const variableName = 'CODE_FILES';
const prettierBinary = join('node_modules', 'prettier', 'bin', 'prettier.cjs');

export const runPrettier = (files, { spawn, workspace = process.cwd() } = {}) =>
	runNodeBinary({
		binary: prettierBinary,
		arguments_: buildPrettierArguments(
			resolveCodeFiles(files, { workspace, variableName }),
		),
		label: 'Prettier',
		spawn,
		workspace,
	});

export const main = (environment = process.env, { spawn } = {}) =>
	runPrettier(parseCodeFiles(environment[variableName], variableName), {
		spawn,
		workspace: resolveWorkspace(environment),
	});

runAsEntrypoint(import.meta.url, main);
