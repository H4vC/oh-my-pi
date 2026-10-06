/**
 * Single-quote a value for a POSIX shell, escaping embedded single quotes.
 * The empty string becomes `''`.
 */
export function quotePosixPath(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "'\\''")}'`;
}
