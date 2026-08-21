import { PRODUCT_NAME } from '../../shared/meta/meta.ts';
import { GLOBAL_FLAGS } from './commands/command.ts';
import type { Command, FlagSpec, FlagSpecs } from './commands/command.ts';
import { COMMANDS } from './commands/registry.ts';

/**
 * Shown for `--help` and for a bare invocation.
 *
 * Both lists are read from the registry rather than written out again here, so
 * a command or a flag cannot exist without the help saying so.
 */
export const helpText = (): string => {
	return [
		`${PRODUCT_NAME} — code-first deployment pipelines for Salesforce`,
		'',
		`Usage: ${PRODUCT_NAME} <command> [options]`,
		'',
		'Commands:',
		...COMMANDS.map((command) => `  ${command.name.padEnd(commandWidth())}  ${command.summary}`),
		'',
		'Options:',
		...flagLines(GLOBAL_FLAGS),
		'',
		`Run \`${PRODUCT_NAME} <command> --help\` for the options that command takes.`,
		'',
	].join('\n');
};

/** Shown for `docket <command> --help`: the flags that command, and only it, takes. */
export const commandHelpText = (command: Command): string => {
	return [
		`${PRODUCT_NAME} ${command.name} — ${command.summary}`,
		'',
		`Usage: ${PRODUCT_NAME} ${command.name} [options]`,
		'',
		...(Object.keys(command.flags).length === 0
			? ['This command takes no options of its own.']
			: ['Options:', ...flagLines(command.flags)]),
		'',
		'Global options:',
		...flagLines(GLOBAL_FLAGS),
		'',
	].join('\n');
};

const commandWidth = (): number => Math.max(...COMMANDS.map((command) => command.name.length));

const flagLines = (flags: FlagSpecs): readonly string[] => {
	const entries = Object.entries(flags);
	const width = Math.max(...entries.map(([name, spec]) => flagLabel(name, spec).length));

	return entries.map(([name, spec]) => `  ${flagLabel(name, spec).padEnd(width)}  ${spec.description}`);
};

const flagLabel = (name: string, spec: FlagSpec): string => {
	return `${spec.short === undefined ? '    ' : `-${spec.short}, `}--${name}`;
};
