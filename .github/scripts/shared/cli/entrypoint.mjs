import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const runAsEntrypoint = (moduleUrl, main) => {
	if (!isEntrypoint(moduleUrl)) {
		return;
	}

	try {
		process.exitCode = main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
};

// Node canonicalizes symlinks while loading a module, so `import.meta.url` is
// already real and `process.argv[1]` is not. Comparing them unresolved makes a
// symlinked checkout skip `main()` and exit 0, turning a failed check green.
export const isEntrypoint = (moduleUrl, entryPath = process.argv[1]) => {
	if (entryPath === undefined) {
		return false;
	}

	try {
		return fileURLToPath(moduleUrl) === realpathSync(entryPath);
	} catch {
		// A path that cannot be resolved is not the module that is running.
		return false;
	}
};
