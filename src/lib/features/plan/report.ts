import type { StepDefinition, TestSelection } from '../config/docket-config.ts';
import type { PlannedComponent } from '../metadata/component-set.ts';
import type { DeploymentPlan } from './deployment-plan.ts';

/**
 * The plan as a person reads it, for a pull-request comment or a job summary.
 *
 * It states what will be deployed, what will be deleted and which tests will
 * run, because a reviewer approves a merge from this text and cannot be
 * expected to diff two manifests in their head.
 */
export function renderReport(plan: DeploymentPlan): string {
	const { source, target } = plan;

	return [
		`# Deployment plan — ${target.environmentId}`,
		'',
		'| Field | Value |',
		'| --- | --- |',
		`| Repository | ${source.repository} |`,
		`| Pull request | #${source.pullRequest} |`,
		`| Base commit | \`${source.baseSha}\` |`,
		`| Head commit | \`${source.headSha}\` |`,
		`| Salesforce org | ${target.org} (${target.orgId}) |`,
		`| Destructive changes | ${plan.allowDestructiveChanges ? 'allowed' : 'not allowed'} |`,
		`| Apex tests | ${describeTests(plan.tests)} |`,
		`| API version | ${plan.apiVersion} |`,
		`| Plan identity | \`${plan.identity}\` |`,
		'',
		...section('Deploy', plan.components.deployable, 'Nothing is deployed.'),
		...section('Delete', plan.components.destructive, 'Nothing is deleted.'),
		...steps(plan),
	].join('\n');
}

/**
 * The runbook, in the order it will happen. A reviewer approving a merge is
 * approving these too, including the ones a person has to carry out.
 */
function steps(plan: DeploymentPlan): readonly string[] {
	const rows = [
		...plan.steps.gates.map((gate) => `| gate | ${gate.name} | \`${gate.run}\` |`),
		...plan.steps.preDeployment.map((step) => `| pre | ${step.name} | ${describeStep(step)} |`),
		...plan.steps.postDeployment.map((step) => `| post | ${step.name} | ${describeStep(step)} |`),
	];

	if (rows.length === 0) return ['## Steps', '', 'No gates or deployment steps are configured.', ''];

	return ['## Steps', '', '| When | Name | What |', '| --- | --- | --- |', ...rows, ''];
}

function describeStep(step: StepDefinition): string {
	return step.kind === 'manual' ? `manual — ${step.instructions}` : `\`${step.run}\``;
}

function section(
	title: string,
	components: readonly PlannedComponent[],
	empty: string,
): readonly string[] {
	if (components.length === 0) return [`## ${title}`, '', empty, ''];

	return [
		`## ${title} (${components.length})`,
		'',
		'| Type | Member | Change |',
		'| --- | --- | --- |',
		...components.map(
			(component) => `| ${component.type} | ${component.member} | ${component.change} |`,
		),
		'',
	];
}

export function describeTests(tests: TestSelection): string {
	return tests.mode === 'all' ? 'all local tests' : tests.classes.join(', ');
}
