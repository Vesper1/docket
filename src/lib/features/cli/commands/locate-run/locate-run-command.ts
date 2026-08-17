import { ErrorCode } from '../../../../shared/result/docket-error.ts';
import { ok } from '../../../../shared/result/result.ts';
import { parseCommitSha } from '../../../git/commit-sha.ts';
import { findOriginatingRun } from '../../../github/checks.ts';
import { defineCommand } from '../command.ts';
import { flagsFor } from '../flags.ts';
import { requiredOption } from '../option.ts';
import { githubClientOf } from '../pipeline-options.ts';

const flags = flagsFor('repository', 'head', 'github-token');

/**
 * `docket locate-run` — find the validation run a green check points at.
 *
 * The post-merge workflow calls this before it downloads anything: the run id
 * it gets back is the only one whose artifacts may be deployed.
 */
export const locateRunCommand = defineCommand({
	name: 'locate-run',
	summary: 'Print the workflow run a green check points at',
	flags,
	run: async (options, context) => {
		const repository = requiredOption(options.repository, '--repository');
		if (!repository.ok) return repository;

		const head = requiredOption(options.head, '--head');
		if (!head.ok) return head;
		const headSha = parseCommitSha(head.value, '--head', ErrorCode.invalidOption);
		if (!headSha.ok) return headSha;

		const client = githubClientOf(options, context);
		if (!client.ok) return client;

		const originating = await findOriginatingRun(client.value, repository.value, headSha.value);
		if (!originating.ok) return originating;

		return ok({ kind: 'originating-run', originating: originating.value });
	},
});
