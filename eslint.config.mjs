import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
	globalIgnores(['legacy/', 'node_modules/', '.agents/', '.claude/']),

	js.configs.recommended,
	tseslint.configs.recommended,

	{
		files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.node,
		},
		plugins: { 'import-x': importX },
		rules: {
			// Node built-ins first, then dependencies, then this repository's own
			// modules, each group separated by a blank line and alphabetised. The
			// order says where a symbol comes from before you read its name.
			'import-x/order': [
				'error',
				{
					// Parent imports keep their own group ahead of siblings, so a file
					// reads outwards in: Node, then dependencies, then shared modules,
					// then the ones next to it.
					groups: [
						'builtin',
						'external',
						'internal',
						'parent',
						'sibling',
						'index',
					],
					'newlines-between': 'always',
					alphabetize: { order: 'asc', caseInsensitive: true },
				},
			],
			'import-x/no-duplicates': 'error',
			// A module that imports itself, or a cycle, is a structural mistake that
			// only shows up at runtime as an undefined export.
			'import-x/no-self-import': 'error',

			eqeqeq: ['error', 'always'],
			'no-var': 'error',
			'prefer-const': 'error',
			'object-shorthand': 'error',
		},
	},
]);
