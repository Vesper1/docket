import { docketError, ErrorCode } from '../../shared/result/docket-error.ts';
import type { DocketError } from '../../shared/result/docket-error.ts';
import { err, ok } from '../../shared/result/result.ts';
import type { Result } from '../../shared/result/result.ts';

export interface GitHubClient {
	/** A scoped token. Never logged, never written to an artifact. */
	readonly token: string;
	/** Overridden for GitHub Enterprise, and by tests. */
	readonly baseUrl?: string;
	/** Injected so fixtures exercise the real request shaping without network. */
	readonly fetch?: typeof globalThis.fetch;
}

export const GITHUB_API_URL = 'https://api.github.com';

/**
 * Pinned so a future default version cannot change what Docket reads out of a
 * pull request without anyone noticing.
 */
const API_VERSION = '2022-11-28';

export interface GitHubRequest {
	readonly method: 'GET' | 'POST' | 'PATCH';
	/** Path below the API root, e.g. `/repos/acme/app/pulls/42`. */
	readonly path: string;
	readonly body?: unknown;
	/** Accept header override, for endpoints that return something else. */
	readonly accept?: string;
}

export interface GitHubResponse {
	readonly status: number;
	readonly body: unknown;
}

/**
 * One GitHub API call.
 *
 * Failures come back as values like everything else, and the message never
 * includes the token or the response body wholesale — a 401 from GitHub with
 * the request echoed back is a good way to write a credential into a log.
 */
export const githubRequest = async (
	client: GitHubClient,
	request: GitHubRequest,
): Promise<Result<GitHubResponse, DocketError>> => {
	const call = client.fetch ?? globalThis.fetch;
	const url = `${client.baseUrl ?? GITHUB_API_URL}${request.path}`;

	let response: Response;
	try {
		response = await call(url, {
			method: request.method,
			headers: {
				accept: request.accept ?? 'application/vnd.github+json',
				authorization: `Bearer ${client.token}`,
				'x-github-api-version': API_VERSION,
				'user-agent': 'docket',
				...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return err(docketError(ErrorCode.githubFailed, `${request.method} ${request.path}: ${detail}`));
	}

	const text = await response.text().catch(() => '');
	const body = parseJson(text);

	if (!response.ok) {
		return err(
			docketError(
				ErrorCode.githubFailed,
				`${request.method} ${request.path} failed with ${response.status}: ${messageOf(body)}`,
			),
		);
	}

	return ok({ status: response.status, body });
};

const parseJson = (text: string): unknown => {
	if (text === '') return undefined;

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

const STATUS = /failed with (\d{3}):/;

/**
 * Reads back the HTTP status this module wrote into a failure message. The
 * error value itself carries only a code and prose, so callers that need to
 * tell one refusal from another would otherwise have to match on GitHub's own
 * wording. Keeping the pattern next to the line that formats it means one
 * module owns both halves.
 */
export const responseStatusOf = (error: DocketError): number | undefined => {
	const match = STATUS.exec(error.message);
	return match === null ? undefined : Number(match[1]);
};

/** GitHub explains itself in `message`; anything else is not worth echoing. */
const messageOf = (body: unknown): string => {
	if (typeof body === 'object' && body !== null && 'message' in body) {
		const message = (body as { message: unknown }).message;
		if (typeof message === 'string') return message;
	}

	return 'no message';
};
