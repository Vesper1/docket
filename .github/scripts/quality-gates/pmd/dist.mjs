import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCodeFiles } from '../../shared/paths/code-files.mjs';
import { runCommand } from '../../shared/spawn/command.mjs';

export const defaultPmdVersion = '7.7.0';
// Pinned so a swapped release asset cannot silently run inside CI. Recompute
// with `shasum -a 256` and update together with `defaultPmdVersion`.
export const defaultPmdDigest =
	'be8bf68f6c1d66984bd9645a93e631b78a1c2f42f5f0f8719082fead67553940';

const pmdVersionPattern = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$/u;
const sha256Pattern = /^[A-Fa-f\d]{64}$/u;

export const buildPmdUrl = (version) => {
	if (!pmdVersionPattern.test(version)) {
		throw new TypeError(
			`PMD_VERSION must be a semantic version, got \`${version}\` (${typeof version})`,
		);
	}

	return `https://github.com/pmd/pmd/releases/download/pmd_releases%2F${version}/pmd-dist-${version}-bin.zip`;
};

export const assertSha256 = (archive, expectedDigest) => {
	if (!sha256Pattern.test(expectedDigest)) {
		throw new TypeError(
			`PMD_DIST_SHA256 must be a 64-character hexadecimal digest, got \`${expectedDigest}\` (${typeof expectedDigest})`,
		);
	}

	const actualDigest = createHash('sha256')
		.update(readFileSync(archive))
		.digest('hex');

	if (actualDigest !== expectedDigest.toLowerCase()) {
		throw new Error(
			`PMD archive digest mismatch: expected ${expectedDigest.toLowerCase()}, got ${actualDigest}. Set PMD_DIST_SHA256 when changing PMD_VERSION.`,
		);
	}
};

export const installPmd = ({ workDirectory, digest, spawn, version }) => {
	const archive = join(workDirectory, 'pmd.zip');
	const downloadStatus = runCommand({
		command: 'curl',
		arguments_: [
			'--fail',
			'--silent',
			'--show-error',
			'--location',
			// A release URL that redirects to plain HTTP must fail, not download.
			'--proto',
			'=https',
			'--proto-redir',
			'=https',
			'--retry',
			'3',
			'--output',
			archive,
			buildPmdUrl(version),
		],
		spawn,
		workspace: workDirectory,
	});

	if (downloadStatus !== 0) {
		return { binary: undefined, status: downloadStatus };
	}

	assertSha256(archive, digest);

	const unzipStatus = runCommand({
		command: 'unzip',
		arguments_: ['-q', archive, '-d', workDirectory],
		spawn,
		workspace: workDirectory,
	});

	if (unzipStatus !== 0) {
		return { binary: undefined, status: unzipStatus };
	}

	const [binary] = resolveCodeFiles(
		[join(`pmd-bin-${version}`, 'bin', 'pmd')],
		{
			workspace: workDirectory,
			variableName: 'PMD_BINARY',
		},
	);

	try {
		accessSync(binary, constants.X_OK);
	} catch (error) {
		throw new Error(`PMD binary not found or not executable: ${binary}`, {
			cause: error,
		});
	}

	return { binary, status: 0 };
};
