/**
 * A GitHub that answers from a table instead of the network.
 *
 * It is a `fetch`, not a stubbed client, so the request shaping Docket relies
 * on — the path, the method, the headers, the JSON body — is exercised exactly
 * as it would be against the real API. What it cannot prove is that GitHub
 * agrees; only M8 running on real Actions can.
 */
export interface FakeGitHub {
	readonly baseUrl: string;
	readonly fetch: typeof globalThis.fetch;
	/** Every request made, in order. */
	requests(): readonly RecordedRequest[];
}

export interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly authorization: string | null;
}

export interface RouteResponse {
	readonly status: number;
	readonly body: unknown;
}

/** Keyed by `"<METHOD> <path>"`, e.g. `"GET /repos/acme/app/pulls/42"`. */
export type Routes = Readonly<Record<string, RouteResponse | ((request: RecordedRequest) => RouteResponse)>>;

const BASE_URL = 'https://github.invalid/api/v3';

export const createFakeGitHub = (routes: Routes): FakeGitHub => {
	const recorded: RecordedRequest[] = [];

	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(typeof input === 'string' ? input : String(input));
		const method = init?.method ?? 'GET';
		const headers = new Headers(init?.headers);
		// The base URL carries a path prefix, as GitHub Enterprise does. Routes
		// are written the way Docket writes them, below that prefix.
		const path = url.pathname.slice(new URL(BASE_URL).pathname.length);
		const request: RecordedRequest = {
			method,
			path,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
			authorization: headers.get('authorization'),
		};
		recorded.push(request);

		const route = routes[`${method} ${path}`];
		const response =
			route === undefined
				? { status: 404, body: { message: 'Not Found' } }
				: typeof route === 'function'
					? route(request)
					: route;

		return new Response(JSON.stringify(response.body), {
			status: response.status,
			headers: { 'content-type': 'application/json' },
		});
	};

	return { baseUrl: BASE_URL, fetch: fetchImpl, requests: () => recorded };
};

/** A pull request as GitHub returns it, trimmed to what Docket reads. */
export const pullRequestBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
	return {
		number: 42,
		state: 'open',
		draft: false,
		merged: false,
		merge_commit_sha: null,
		base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'acme/salesforce' } },
		head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'acme/salesforce' } },
		...overrides,
	};
};
