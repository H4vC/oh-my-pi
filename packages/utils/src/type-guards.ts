export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads an own string-valued property without invoking accessors. */
export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

/** Returns `value` when it is a finite number; missing, non-numeric, NaN, and infinite values become 0. */
export function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
