import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';
import { runSf } from './sf-cli.ts';
import type { SalesforceCli } from './sf-cli.ts';
import { parseSalesforceOrgId } from './org-id.ts';

/** A Salesforce org, identified by what the org itself reports. */
export interface ResolvedOrg {
	/** The alias or username `docket.yml` configured. */
	readonly reference: string;
	/** The 18-character org id. This, not the alias, identifies a plan's target. */
	readonly id: string;
	readonly username: string;
	/** The org's instance URL, recorded so a run says where it went. */
	readonly instanceUrl: string;
}

/**
 * Turns a configured org reference into the org it actually points at.
 *
 * An alias is a local nickname that anyone can repoint, so it must never be
 * what a plan is bound to. Resolving it once, up front, is what makes "deploy
 * only to the org that was validated" a checkable statement.
 */
export async function resolveOrg(
	cli: SalesforceCli,
	reference: string,
): Promise<Result<ResolvedOrg, DocketError>> {
	const envelope = await runSf(cli, ['org', 'display', '--target-org', reference]);
	if (!envelope.ok) return envelope;

	const result = envelope.value.result;
	const org =
		typeof result === 'object' && result !== null && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: undefined;

	if (org === undefined || envelope.value.status !== 0) {
		const detail = envelope.value.message ?? 'the CLI reported no org';
		return err(docketError(ErrorCode.orgUnavailable, `cannot use org \`${reference}\`: ${detail}`));
	}

	const id = parseSalesforceOrgId(org['id'], `org \`${reference}\` id`, ErrorCode.orgUnavailable);
	const username = string(org['username']);
	if (!id.ok || username === undefined) {
		return err(
			docketError(ErrorCode.orgUnavailable, `org \`${reference}\` reported no id or username`),
		);
	}

	// A cached authentication that no longer works would otherwise be found out
	// halfway through a deployment, after the plan is already public.
	const connected = string(org['connectedStatus']);
	if (connected !== undefined && connected !== 'Connected') {
		return err(
			docketError(ErrorCode.orgUnavailable, `org \`${reference}\` is not connected: ${connected}`),
		);
	}

	return ok({ reference, id: id.value, username, instanceUrl: string(org['instanceUrl']) ?? '' });
}

/**
 * Refuses an org that is not the one a plan was validated against.
 *
 * The alias may be identical and still resolve elsewhere — a re-authenticated
 * sandbox, a refreshed org, a laptop with different local aliases.
 */
export function requireOrgId(org: ResolvedOrg, expectedId: string): Result<ResolvedOrg, DocketError> {
	if (org.id === expectedId) return ok(org);

	return err(
		docketError(
			ErrorCode.orgMismatch,
			`org \`${org.reference}\` is ${org.id}, but the plan was validated against ${expectedId}`,
		),
	);
}

function string(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}
