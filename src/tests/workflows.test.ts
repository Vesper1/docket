import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';

/**
 * The workflow templates are part of the contract: they are what makes a green
 * check gate a merge and a merge start a deployment. These checks are
 * structural — only a real Actions run can prove GitHub agrees.
 */
const TEMPLATES = new URL('../../templates/github/', import.meta.url);

async function workflow(name: string): Promise<Record<string, any>> {
	const path = fileURLToPath(new URL(name, TEMPLATES));
	return parse(await readFile(path, 'utf8')) as Record<string, any>;
}

/** YAML reads a bare `on:` key as the boolean true; ask for both spellings. */
function triggers(document: Record<string, any>): Record<string, any> {
	return document['on'] ?? document[true as unknown as string];
}

describe('the validation workflow', () => {
	test('runs on pull request events and publishes a check', async () => {
		const document = await workflow('docket-validate.yml');

		expect(triggers(document).pull_request.types).toContain('synchronize');
		expect(document.permissions).toEqual({ contents: 'read' });
		expect(document.jobs.gates.permissions).toEqual({ contents: 'read' });
		expect(document.jobs.validate.permissions).toEqual({
			contents: 'read',
			actions: 'read',
			checks: 'write',
		});
	});

	test('refuses forks and drafts before the job holds any credential', async () => {
		const { jobs } = await workflow('docket-validate.yml');

		expect(jobs.gates.if).toContain('draft == false');
		expect(jobs.gates.if).toContain('head.repo.full_name == github.repository');
	});

	test('runs candidate gates in a separate job with no Salesforce environment', async () => {
		const { jobs } = await workflow('docket-validate.yml');
		const steps: any[] = jobs.gates.steps;

		const checkout = steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout'));
		expect(checkout.with.ref).toBe('${{ github.event.pull_request.head.sha }}');
		expect(checkout.with['persist-credentials']).toBe(false);
		expect(jobs.gates.environment).toBeUndefined();
		expect(steps.some((step) => String(step.run ?? '').includes('$DOCKET gates'))).toBe(true);
		expect(steps.some((step) => String(step.run ?? '').includes('SF_AUTH_URL'))).toBe(false);
	});

	test('credentialed validation consumes the exact passing gate artifact', async () => {
		const { jobs } = await workflow('docket-validate.yml');
		const steps: any[] = jobs.validate.steps;
		const validate = steps.find((step) => step.id === 'validate');

		expect(jobs.validate.needs).toBe('gates');
		expect(validate.run).toContain('--gates-run "$RUNNER_TEMP/docket-gates"');
		expect(validate.run).toContain('--workflow-run-id "$GITHUB_RUN_ID"');
		expect(validate.run).toContain('--workflow-run-attempt "$GITHUB_RUN_ATTEMPT"');
		expect(steps.findIndex((step) => String(step.run ?? '').includes('SF_AUTH_URL'))).toBeLessThan(
			steps.findIndex((step) => step.id === 'validate'),
		);
	});

	test('artifacts are named by pull request and head SHA', async () => {
		const { jobs } = await workflow('docket-validate.yml');
		const upload = (jobs.validate.steps as any[]).find((step) =>
			String(step.uses ?? '').startsWith('actions/upload-artifact'),
		);

		expect(upload.with.name).toContain('${{ github.event.pull_request.number }}');
		expect(upload.with.name).toContain('${{ github.event.pull_request.head.sha }}');
	});

	test('a failed validation still publishes its check, then fails the job', async () => {
		const { jobs } = await workflow('docket-validate.yml');
		const steps: any[] = jobs.validate.steps;

		const validate = steps.find((step) => step.id === 'validate');
		expect(validate['continue-on-error']).toBe(true);

		const publish = steps.findIndex((step) => String(step.run ?? '').includes('publish-check'));
		const fail = steps.findIndex((step) => step.if === "steps.validate.outcome != 'success'");
		expect(publish).toBeGreaterThan(-1);
		expect(fail).toBeGreaterThan(publish);
	});
});

describe('the deployment workflow', () => {
	test('only a merged pull request reaches it', async () => {
		const document = await workflow('docket-deploy.yml');

		expect(triggers(document).pull_request.types).toEqual(['closed']);
		expect(document.jobs.locate.if).toBe('github.event.pull_request.merged == true');
	});

	test('the plan comes from the run the green check points at', async () => {
		const { jobs } = await workflow('docket-deploy.yml');
		const locate = (jobs.locate.steps as any[]).find((step) => step.id === 'locate');
		const download = (jobs.deploy.steps as any[]).find((step) =>
			String(step.uses ?? '').startsWith('actions/download-artifact'),
		);
		const deploy = (jobs.deploy.steps as any[]).find((step) =>
			String(step.run ?? '').includes('$DOCKET deploy'),
		);

		expect(locate.run).toContain('--json');
		expect(jobs.locate.outputs.plan_identity).toBe('${{ steps.locate.outputs.plan_identity }}');
		expect(download.with['run-id']).toBe('${{ needs.locate.outputs.run_id }}');
		expect(download.with['github-token']).toBe('${{ github.token }}');
		expect(deploy.run).toContain('--expected-plan-identity "${{ needs.locate.outputs.plan_identity }}"');
	});

	test('deployment is serialized per Salesforce org and never cancelled', async () => {
		const { jobs } = await workflow('docket-deploy.yml');

		expect(jobs.deploy.concurrency.group).toBe('docket-deploy-${{ needs.locate.outputs.org_id }}');
		expect(jobs.deploy.concurrency['cancel-in-progress']).toBe(false);
		expect(jobs.deploy.concurrency.queue).toBe('max');
	});

	test('the concurrency key comes from a verified bundle bound to the green check', async () => {
		const { jobs } = await workflow('docket-deploy.yml');
		const inspect = (jobs.locate.steps as any[]).find((step) =>
			String(step.run ?? '').includes('$DOCKET inspect-run'),
		);

		expect(inspect.run).toContain('--run "$RUNNER_TEMP/docket-run"');
		expect(inspect.run).toContain(
			'--expected-plan-identity "${{ steps.locate.outputs.plan_identity }}"',
		);
		expect(inspect.run).toContain('.data.run.plan.target.orgId');
	});

	test('the deployment re-verifies the merge instead of trusting the event', async () => {
		const { jobs } = await workflow('docket-deploy.yml');
		const deploy = (jobs.deploy.steps as any[]).find((step) =>
			String(step.run ?? '').includes('docket deploy') || String(step.run ?? '').includes('$DOCKET deploy'),
		);

		expect(deploy.run).toContain('--require-merged');
		expect(deploy.run).toContain('--validated-run');
		expect(deploy.run).toContain('--steps');
		expect(deploy.run).toContain('--workflow-run-id "$GITHUB_RUN_ID"');
		expect(deploy.run).toContain('--workflow-run-attempt "$GITHUB_RUN_ATTEMPT"');
	});

	test('manual completions come only from workflow runs named by successful step checks', async () => {
		const { jobs } = await workflow('docket-deploy.yml');
		const locate = (jobs.locate.steps as any[]).find((step) =>
			String(step.run ?? '').includes('locate-steps'),
		);
		const download = (jobs.deploy.steps as any[]).find((step) =>
			String(step.run ?? '').includes('gh run download'),
		);

		expect(locate.run).toContain('--validated-run');
		expect(download.env.COMPLETION_RUNS).toBe('${{ needs.locate.outputs.completion_runs }}');
		expect(download.run).toContain('--name "docket-step-$run_id"');
	});

	test('the record survives a failed deployment', async () => {
		const { jobs } = await workflow('docket-deploy.yml');
		const upload = (jobs.deploy.steps as any[]).find((step) =>
			String(step.uses ?? '').startsWith('actions/upload-artifact'),
		);

		expect(upload.if).toBe('always()');
	});

	test('no workflow asks for more permission than it uses', async () => {
		const deploy = await workflow('docket-deploy.yml');

		expect(deploy.permissions).toEqual({ contents: 'read', actions: 'read', checks: 'read' });
		expect(deploy.permissions['contents']).not.toBe('write');
	});
});

describe('the manual-step workflow', () => {
	test('is an explicit default-branch dispatch using the GitHub actor identity', async () => {
		const document = await workflow('docket-complete-step.yml');
		const steps: any[] = document.jobs.complete.steps;
		const record = steps.find((step) => String(step.run ?? '').includes('$DOCKET complete-step'));

		expect(triggers(document).workflow_dispatch.inputs).toHaveProperty('pull_request');
		expect(document.permissions).toEqual({ contents: 'read', actions: 'read', checks: 'write' });
		expect(record.run).toContain('--by "$GITHUB_ACTOR"');
	});

	test('uploads immutable evidence before it turns the existing check green', async () => {
		const document = await workflow('docket-complete-step.yml');
		const steps: any[] = document.jobs.complete.steps;
		const upload = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/upload-artifact'));
		const publish = steps.findIndex((step) =>
			String(step.name ?? '').includes('Complete the existing required check'),
		);

		expect(upload).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(upload);
		expect(steps[upload].with.name).toBe('docket-step-${{ github.run_id }}');
		expect(steps[publish].run).toContain('--repository "$GITHUB_REPOSITORY"');
	});
});

describe('the rollback workflow', () => {
	test('creates only a same-repository compensating PR and leaves Salesforce to the normal flow', async () => {
		const rollback = await workflow('docket-rollback.yml');
		const steps: any[] = rollback.jobs.propose.steps;
		const create = steps.find((step) => String(step.run ?? '').includes('$DOCKET rollback'));
		const validate = await workflow('docket-validate.yml');
		const deploy = await workflow('docket-deploy.yml');

		expect(triggers(rollback).workflow_dispatch.inputs).toHaveProperty('source_run_id');
		expect(rollback.permissions).toEqual({
			contents: 'write',
			'pull-requests': 'write',
			actions: 'read',
		});
		expect(create.run).toContain('--repository "$GITHUB_REPOSITORY"');
		expect(create.run).toContain('--create-pr');
		expect(create.env.GITHUB_TOKEN).toBe('${{ secrets.DOCKET_PR_TOKEN || github.token }}');
		expect(JSON.stringify(rollback)).not.toContain('SF_AUTH_URL');
		expect(JSON.stringify(rollback)).not.toContain('$DOCKET deploy');
		expect(triggers(validate).pull_request.types).toContain('opened');
		expect(JSON.stringify(deploy.jobs.deploy.steps)).toContain('$DOCKET deploy');
	});
});

describe('the deployment-history workflow', () => {
	test('rebuilds history only from exact run artifacts and uses no database', async () => {
		const history = await workflow('docket-history.yml');
		const steps: any[] = history.jobs.history.steps;
		const download = steps.find((step) => String(step.run ?? '').includes('gh run download'));
		const build = steps.find((step) => String(step.run ?? '').includes('$DOCKET history'));

		expect(triggers(history).workflow_dispatch.inputs).toHaveProperty('run_ids');
		expect(history.permissions).toEqual({ contents: 'read', actions: 'read' });
		expect(download.run).toContain('--pattern \'docket-deployment-*\'');
		expect(build.run).toContain('--runs "$RUNNER_TEMP/docket-history-input"');
		expect(JSON.stringify(history)).not.toMatch(/sqlite|postgres|database[_-]url/i);
	});
});

/**
 * Every workflow starts by installing the engine, and each of them is trusted
 * to install the same one. A step that installed something else — or that
 * needed a credential to do it, next to the candidate commands that run
 * afterwards — would undo the guarantees the rest of this file checks.
 */
describe('the pinned engine install', () => {
	const TEMPLATE_NAMES = [
		'docket-validate.yml',
		'docket-deploy.yml',
		'docket-complete-step.yml',
		'docket-rollback.yml',
		'docket-history.yml',
	];

	async function installSteps(name: string): Promise<any[]> {
		const { jobs } = await workflow(name);
		return Object.values(jobs as Record<string, any>)
			.flatMap((job: any) => (job.steps ?? []) as any[])
			.filter((step) => String(step.run ?? '').includes('npm install --global "$DOCKET_PACKAGE"'));
	}

	test.each(TEMPLATE_NAMES)('%s refuses to run before DOCKET_PACKAGE names an engine', async (name) => {
		const steps = await installSteps(name);

		expect(steps.length).toBeGreaterThan(0);
		for (const step of steps) {
			expect(step.run).toContain('if [ -z "${DOCKET_PACKAGE:-}" ]');
			expect(step.run).toContain('exit 1');
		}
	});

	test.each(TEMPLATE_NAMES)('%s installs the engine without holding a secret', async (name) => {
		const steps = await installSteps(name);

		for (const step of steps) {
			// A public package needs no credential, and the gate job runs
			// candidate commands right after this step: a token here would be
			// readable by them for the rest of the job.
			expect(step.env).toBeUndefined();
			expect(step.run).toContain('npm install --global "$DOCKET_PACKAGE"\n');
			expect(step.run).not.toContain('_authToken');
			expect(step.run).not.toContain('NPM_CONFIG_USERCONFIG');
		}
	});
});
