import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// `legacy/` is parked reference code, not part of the build. Its imports
		// point at modules that stayed in `src/`, so it neither compiles nor runs
		// — which is fine for something kept to be read, not executed.
		exclude: ['node_modules/**', 'legacy/**'],
	},
});
