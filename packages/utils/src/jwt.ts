/**
 * Decode a JWT payload without verifying its signature; `null` for malformed
 * tokens (not three segments, empty payload, invalid JSON, or a non-object
 * payload). Accepts base64url and plain base64 payload encodings.
 *
 * Only for reading claims of tokens this process already trusts (its own
 * OAuth access/id tokens); never for authenticating a caller.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
			? (decoded as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
