// Builds the single-file engine a Salesforce repository vendors as
// `.docket/docket.mjs`. One file, no `node_modules`, no install step: the
// workflows read it straight out of a trusted commit.
import { readFile, writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const outfile = new URL('bundle/docket.mjs', root);

await build({
	entryPoints: [new URL('src/bin/docket.ts', root).pathname],
	outfile: outfile.pathname,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node24',
	// `yaml` resolves as CommonJS and calls `require`, which an ESM bundle has
	// no binding for.
	banner: {
		js: [
			"import { createRequire as __docketCreateRequire } from 'node:module';",
			'const require = __docketCreateRequire(import.meta.url);',
		].join('\n'),
	},
	// The vendored file stands alone, so it cannot read the manifest beside it.
	define: { __DOCKET_VERSION__: JSON.stringify(version) },
});

// Stated in the bundle itself, so `sha256sum` in a workflow log and a release
// asset can be compared without trusting a separate VERSION file.
const bundled = await readFile(outfile, 'utf8');
await writeFile(outfile, `${bundled}\n// docket ${version}\n`);
console.log(`bundle/docket.mjs — docket ${version}`);
