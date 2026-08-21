import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { completedStatus } from './result.mjs';

export const runCommand = ({
	command,
	arguments_,
	label = command,
	spawn = spawnSync,
	workspace,
}) =>
	completedStatus(
		spawn(command, arguments_, {
			cwd: workspace,
			stdio: 'inherit',
			shell: false,
		}),
		label,
	);

// Running the workspace copy of a CLI through `process.execPath` keeps the tool
// on the Node version the workflow pinned, and never on a PATH lookup.
export const runNodeBinary = ({
	binary,
	arguments_,
	label,
	spawn,
	workspace,
}) =>
	runCommand({
		command: process.execPath,
		arguments_: [join(workspace, binary), ...arguments_],
		label,
		spawn,
		workspace,
	});
