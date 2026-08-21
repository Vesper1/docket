import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAsEntrypoint } from '../../shared/cli/entrypoint.mjs';
import { resolveCodeFiles } from '../../shared/paths/code-files.mjs';
import { resolveWorkspace } from '../../shared/paths/workspace.mjs';
import { runCommand } from '../../shared/spawn/command.mjs';

import { parseApexFiles } from './apex-files.mjs';
import { defaultPmdDigest, defaultPmdVersion, installPmd } from './dist.mjs';

const variableName = 'APEX_FILES';
const defaultRuleset = '.github/pmd/apex-ruleset.xml';

export const runApexPmd = (environment = process.env, dependencies = {}) => {
	const {
		spawn,
		stdout = process.stdout,
		workspace = resolveWorkspace(environment),
		runnerTemp = environment.RUNNER_TEMP ?? tmpdir(),
	} = dependencies;
	const version = environment.PMD_VERSION ?? defaultPmdVersion;
	const digest = environment.PMD_DIST_SHA256 ?? defaultPmdDigest;
	const absoluteFiles = resolveCodeFiles(
		parseApexFiles(environment[variableName], variableName),
		{ workspace, variableName },
	);
	const [ruleset] = resolveCodeFiles(
		[environment.PMD_RULESET ?? defaultRuleset],
		{ workspace, variableName: 'PMD_RULESET' },
	);
	const workDirectory = mkdtempSync(join(runnerTemp, 'docket-pmd-'));

	try {
		const { binary, status } = installPmd({
			workDirectory,
			digest,
			spawn,
			version,
		});

		if (status !== 0) {
			return status;
		}

		const fileList = join(workDirectory, 'apex-files.txt');
		writeFileSync(fileList, `${absoluteFiles.join('\n')}\n`, {
			encoding: 'utf8',
			flag: 'wx',
		});
		stdout.write(
			`Running PMD ${version} on ${absoluteFiles.length} Apex file(s)\n`,
		);

		return runCommand({
			command: binary,
			arguments_: [
				'check',
				'--rulesets',
				ruleset,
				'--file-list',
				fileList,
				'--format',
				'text',
				'--no-progress',
				'--cache',
				join(workDirectory, 'pmd-analysis-cache'),
			],
			label: 'PMD',
			spawn,
			workspace,
		});
	} finally {
		rmSync(workDirectory, { recursive: true, force: true });
	}
};

export { runApexPmd as main };

runAsEntrypoint(import.meta.url, runApexPmd);
