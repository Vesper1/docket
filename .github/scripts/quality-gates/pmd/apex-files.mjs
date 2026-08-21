import { parseCodeFiles } from '../../shared/paths/code-files.mjs';

const lineBreakPattern = /[\r\n]/u;

export const parseApexFiles = (value, variableName = 'APEX_FILES') => {
	const files = parseCodeFiles(value, variableName);

	for (const file of files) {
		if (lineBreakPattern.test(file)) {
			// PMD reads a newline-delimited file list, so either character would
			// split one path into an extra, unchecked entry.
			throw new TypeError(
				`${variableName} path contains a line break: ${file}`,
			);
		}
	}

	return files;
};
