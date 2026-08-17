import { isAbsolute, join } from 'node:path';

/**
 * A path a caller typed is read relative to where they stood, never relative
 * to wherever Docket happens to be running from.
 */
export function absolutePath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}
