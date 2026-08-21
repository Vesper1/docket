import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const createWorkspaceFixture = ({ files = [] } = {}) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'docket-workspace-')));
	const workspace = join(root, 'workspace');
	const runnerTemp = join(root, 'runner-temp');

	mkdirSync(workspace);
	mkdirSync(runnerTemp);
	for (const [path, contents = ''] of files) {
		const absolutePath = join(workspace, path);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, contents);
	}

	return {
		remove: () => rmSync(root, { recursive: true, force: true }),
		root,
		runnerTemp,
		workspace,
	};
};
