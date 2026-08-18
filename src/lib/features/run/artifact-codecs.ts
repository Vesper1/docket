import type { GateDefinition, StepDefinition, TestSelection } from '../config/docket-config.ts';
import { canonicalJson } from '../../shared/json/canonical-json.ts';
import type { PlannedComponent } from '../metadata/component-set.ts';
import type { DeploymentPlan } from '../plan/deployment-plan.ts';
import { PLAN_SCHEMA } from '../plan/deployment-plan.ts';
import type { DeploymentOutcome } from '../salesforce/deploy.ts';
import type { StepResult, ValidationRecord } from '../validation/validation-record.ts';
import { VALIDATION_SCHEMA } from '../validation/validation-record.ts';
import type { RunRecord } from './run-record.ts';
import { RUN_SCHEMA } from './run-record.ts';
import { isSalesforceOrgId } from '../salesforce/org-id.ts';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Runtime decoders for artifacts downloaded from an external artifact store. */
export function isDeploymentPlan(value: unknown): value is DeploymentPlan {
	const plan = asRecord(value);
	const source = asRecord(plan?.['source']);
	const target = asRecord(plan?.['target']);
	const components = asRecord(plan?.['components']);
	const steps = asRecord(plan?.['steps']);
	const digests = asRecord(plan?.['manifestDigests']);

	if (
		plan?.['schema'] !== PLAN_SCHEMA ||
		!repository(source?.['repository']) ||
		!positiveInteger(source?.['pullRequest']) ||
		!matches(source?.['baseSha'], SHA) ||
		!matches(source?.['headSha'], SHA) ||
		!text(target?.['environmentId']) ||
		!text(target?.['org']) ||
		!isSalesforceOrgId(target?.['orgId']) ||
		!isTestSelection(plan['tests']) ||
		typeof plan['allowDestructiveChanges'] !== 'boolean' ||
		!text(plan['apiVersion']) ||
		!isPlannedComponents(components?.['deployable'], ['added', 'modified']) ||
		!isPlannedComponents(components?.['destructive'], ['deleted']) ||
		!isGateDefinitions(steps?.['gates']) ||
		!isStepDefinitions(steps?.['preDeployment'], true) ||
		!isStepDefinitions(steps?.['postDeployment'], false) ||
		!matches(digests?.['packageXml'], DIGEST) ||
		!(digests?.['destructiveChangesXml'] === null || matches(digests?.['destructiveChangesXml'], DIGEST)) ||
		!matches(plan['identity'], DIGEST)
	) {
		return false;
	}

	return (
		plan['allowDestructiveChanges'] === true ||
		(Array.isArray(components['destructive']) && components['destructive'].length === 0)
	);
}

export function isValidationRecord(value: unknown): value is ValidationRecord {
	const validation = asRecord(value);
	const org = asRecord(validation?.['org']);
	const deployment = validation?.['deployment'];
	const failures = validation?.['failures'];

	if (
		validation?.['schema'] !== VALIDATION_SCHEMA ||
		!verdict(validation['verdict']) ||
		!matches(validation['planIdentity'], DIGEST) ||
		!text(org?.['reference']) ||
		!isSalesforceOrgId(org?.['id']) ||
		!isTestSelection(validation['tests']) ||
		!isStepResults(validation['steps']) ||
		!oneOf(validation['salesforce'], ['validated', 'not-required']) ||
		!(deployment === null || isDeploymentOutcome(deployment)) ||
		!stringArray(failures)
	) {
		return false;
	}

	if (deployment !== null && deployment.checkOnly !== true) return false;
	// `not-required` is a claim that nothing was asked, so an answer contradicts
	// it. Whether the claim was allowed is checked against the plan, in
	// `isRunRecord`.
	if (validation['salesforce'] === 'not-required' && deployment !== null) return false;

	if (validation['verdict'] === 'passed') {
		return (
			failures.length === 0 &&
			(validation['salesforce'] === 'not-required' ||
				(deployment !== null && deployment.success)) &&
			!validation['steps'].some((step) => step.status === 'failed')
		);
	}

	return failures.length > 0;
}

export function isRunRecord(value: unknown): value is RunRecord {
	const run = asRecord(value);
	const timing = asRecord(run?.['timing']);
	const validation = run?.['validation'];
	const deployment = run?.['deployment'];
	const workflow = run?.['workflow'];
	const mergeCommit = run?.['mergeCommit'];
	const expires = run?.['artifactsExpireAt'];

	if (
		run?.['schema'] !== RUN_SCHEMA ||
		!oneOf(run['kind'], ['validate', 'deploy', 'rollback']) ||
		!oneOf(run['executor'], ['local', 'github-actions']) ||
		!verdict(run['status']) ||
		!isoDate(timing?.['startedAt']) ||
		!isoDate(timing?.['finishedAt']) ||
		!isDeploymentPlan(run['plan']) ||
		!(validation === null || isValidationRecord(validation)) ||
		!(deployment === null || isDeploymentOutcome(deployment)) ||
		!isStepResults(run['steps']) ||
		!(workflow === null || isWorkflow(workflow)) ||
		!(mergeCommit === null || matches(mergeCommit, SHA)) ||
		!(expires === null || isoDate(expires))
	) {
		return false;
	}

	if (run['executor'] === 'local' ? workflow !== null : workflow === null) return false;
	if (validation === null) return false;

	// Only a plan with nothing in it may claim Salesforce was not required, and
	// such a plan may not claim otherwise: this is what stops an artifact from
	// buying a green verdict by asserting there was nothing to validate.
	const emptyPlan =
		run['plan'].components.deployable.length === 0 &&
		run['plan'].components.destructive.length === 0;
	if (emptyPlan !== (validation.salesforce === 'not-required')) return false;

	if (run['kind'] === 'validate') {
		return (
			run['status'] === validation.verdict &&
			deployment === null &&
			mergeCommit === null &&
			sameJson(run['steps'], validation.steps)
		);
	}

	if (deployment !== null && deployment.checkOnly) return false;
	if (emptyPlan && deployment !== null) return false;
	const failed =
		(!emptyPlan && (deployment === null || !deployment.success)) ||
		run['steps'].some((step) => step.status === 'failed' || step.status === 'pending');
	return run['status'] === (failed ? 'failed' : 'passed');
}

export function isDeploymentOutcome(value: unknown): value is DeploymentOutcome {
	const deployment = asRecord(value);
	const components = deployment?.['componentFailures'];
	const tests = asRecord(deployment?.['tests']);
	const failures = tests?.['failures'];

	if (
		!text(deployment?.['deploymentId']) ||
		!text(deployment['status']) ||
		typeof deployment['success'] !== 'boolean' ||
		typeof deployment['checkOnly'] !== 'boolean' ||
		!Array.isArray(components) ||
		!components.every(isComponentFailure) ||
		!nonNegativeInteger(tests?.['run']) ||
		!nonNegativeInteger(tests?.['failed']) ||
		!Array.isArray(failures) ||
		!failures.every(isTestFailure)
	) {
		return false;
	}

	const succeeded = deployment['status'] === 'Succeeded';
	if (deployment['success'] !== succeeded) return false;
	return !succeeded || (components.length === 0 && tests['failed'] === 0 && failures.length === 0);
}

function isStepResults(value: unknown): value is readonly StepResult[] {
	return Array.isArray(value) && value.every(isStepResult);
}

function isStepResult(value: unknown): value is StepResult {
	const step = asRecord(value);
	if (
		!text(step?.['name']) ||
		!oneOf(step['kind'], ['gate', 'pre', 'post']) ||
		typeof step['manual'] !== 'boolean' ||
		!oneOf(step['status'], ['passed', 'failed', 'skipped', 'pending']) ||
		!(step['exitCode'] === null || integer(step['exitCode'])) ||
		!(step['completedBy'] === null || text(step['completedBy']))
	) {
		return false;
	}

	if (step['kind'] === 'gate' && step['manual']) return false;
	if (step['manual']) {
		if (step['exitCode'] !== null) return false;
		return step['status'] !== 'pending' || step['completedBy'] === null;
	}

	if (step['completedBy'] !== null || step['status'] === 'pending') return false;
	return step['status'] === 'skipped' ? step['exitCode'] === null : integer(step['exitCode']);
}

function isGateDefinitions(value: unknown): value is readonly GateDefinition[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => {
			const gate = asRecord(entry);
			return text(gate?.['name']) && text(gate['run']) && positiveNumber(gate['timeoutMinutes']);
		})
	);
}

function isStepDefinitions(value: unknown, manualAllowed: boolean): value is readonly StepDefinition[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => {
			const step = asRecord(entry);
			if (!text(step?.['name'])) return false;
			if (step['kind'] === 'automatic') {
				return text(step['run']) && positiveNumber(step['timeoutMinutes']);
			}
			return manualAllowed && step['kind'] === 'manual' && text(step['instructions']);
		})
	);
}

function isPlannedComponents(
	value: unknown,
	changes: readonly PlannedComponent['change'][],
): value is readonly PlannedComponent[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => {
			const component = asRecord(entry);
			return (
				component?.['type'] === 'ApexClass' &&
				text(component['member']) &&
				oneOf(component['change'], changes)
			);
		})
	);
}

function isTestSelection(value: unknown): value is TestSelection {
	const tests = asRecord(value);
	if (tests?.['mode'] === 'all') return true;
	return (
		tests?.['mode'] === 'specified' &&
		Array.isArray(tests['classes']) &&
		tests['classes'].length > 0 &&
		tests['classes'].every(text)
	);
}

function isComponentFailure(value: unknown): boolean {
	const failure = asRecord(value);
	return text(failure?.['type']) && text(failure['member']) && text(failure['problem']);
}

function isTestFailure(value: unknown): boolean {
	const failure = asRecord(value);
	return text(failure?.['className']) && text(failure['method']) && text(failure['message']);
}

function isWorkflow(value: unknown): boolean {
	const workflow = asRecord(value);
	return matches(workflow?.['runId'], /^[1-9][0-9]*$/) && positiveInteger(workflow['runAttempt']);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

function repository(value: unknown): value is string {
	return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
	return typeof value === 'string' && pattern.test(value);
}

function verdict(value: unknown): value is 'passed' | 'failed' {
	return value === 'passed' || value === 'failed';
}

function integer(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

function positiveInteger(value: unknown): value is number {
	return integer(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return integer(value) && value >= 0;
}

function positiveNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function stringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function oneOf<T>(value: unknown, values: readonly T[]): value is T {
	return values.some((candidate) => candidate === value);
}

function isoDate(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}
