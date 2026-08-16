/**
 * Patterns for the credentials that could plausibly reach a run artifact.
 *
 * §3 forbids secrets in Git, YAML and run artifacts. A rule is only worth
 * having if it fires on the real shape of the thing: a Salesforce org id is
 * public and appears in every plan, while a session id is the same prefix
 * followed by `!` and a token, and must never be written down.
 */
const PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
	{ name: 'Salesforce session id', pattern: /\b00[DQ][A-Za-z0-9]{12,15}![A-Za-z0-9._-]{10,}/ },
	{ name: 'Salesforce auth url', pattern: /force:\/\/[^\s"']+/ },
	{ name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
	{ name: 'GitHub token', pattern: /\b(?:ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
	{ name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
	{ name: 'assigned secret', pattern: /\b(?:client_secret|refresh_token|access_token|password|passwd)\b\s*[:=]\s*["']?\S+/i },
];

export interface SecretFinding {
	/** Which rule fired, named so a report can say what to remove. */
	readonly rule: string;
	/** 1-indexed line, to point at the offending place without quoting it. */
	readonly line: number;
}

/**
 * Finds credential-shaped text.
 *
 * Deliberately reports the rule and the line but never the match: a scanner
 * that quotes what it found copies the secret into the log that reports it.
 */
export function findSecrets(content: string): readonly SecretFinding[] {
	const findings: SecretFinding[] = [];

	content.split('\n').forEach((line, index) => {
		for (const { name, pattern } of PATTERNS) {
			if (pattern.test(line)) findings.push({ rule: name, line: index + 1 });
		}
	});

	return findings;
}
