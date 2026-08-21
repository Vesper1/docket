import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const parseCodeFiles = (value, variableName = 'CODE_FILES') => {
	if (value === undefined) {
		throw new TypeError(`${variableName} is required`);
	}

	let files;
	try {
		files = JSON.parse(value);
	} catch (error) {
		throw new TypeError(`${variableName} must be valid JSON`, { cause: error });
	}

	if (
		!Array.isArray(files) ||
		files.length === 0 ||
		files.some((file) => typeof file !== 'string' || file.length === 0)
	) {
		throw new TypeError(
			`${variableName} must be a non-empty JSON array of file paths`,
		);
	}

	return files;
};

export const resolveCodeFiles = (
	files,
	{ workspace = process.cwd(), variableName = 'CODE_FILES' } = {},
) => {
	const workspaceRoot = realpathSync(workspace);

	return files.map((file) => {
		if (file.includes('\0')) {
			throw new TypeError(`${variableName} paths cannot contain null bytes`);
		}

		const unresolvedPath = resolve(workspaceRoot, file);
		if (isOutsideWorkspace(unresolvedPath, workspaceRoot)) {
			throw new TypeError(
				`${variableName} path escapes the workspace: ${file}`,
			);
		}

		let absolutePath;
		try {
			// Canonicalizing the final path prevents an in-repository symlink from
			// sending a formatter or linter outside the checked-out workspace.
			absolutePath = realpathSync(unresolvedPath);
		} catch (error) {
			throw new Error(`${variableName} path does not exist: ${file}`, {
				cause: error,
			});
		}

		if (isOutsideWorkspace(absolutePath, workspaceRoot)) {
			throw new TypeError(
				`${variableName} path escapes the workspace: ${file}`,
			);
		}

		if (!statSync(absolutePath).isFile()) {
			throw new TypeError(`${variableName} path is not a file: ${file}`);
		}

		return absolutePath;
	});
};

const isOutsideWorkspace = (path, workspace) => {
	const relativePath = relative(workspace, path);

	return (
		relativePath === '..' ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	);
};
