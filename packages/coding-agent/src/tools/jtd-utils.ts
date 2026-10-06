/**
 * JSON Type Definition (JTD) utility types and guards.
 *
 * Shared type definitions and type guard functions for JTD schema validation.
 *
 * @see https://jsontypedef.com/
 * @see https://datatracker.ietf.org/doc/html/rfc8927
 */

export type JTDPrimitive =
	| "boolean"
	| "string"
	| "timestamp"
	| "float32"
	| "float64"
	| "int8"
	| "uint8"
	| "int16"
	| "uint16"
	| "int32"
	| "uint32";

export interface JTDType {
	type: JTDPrimitive;
}

export interface JTDEnum {
	enum: string[];
}

export interface JTDElements {
	elements: JTDSchema;
}

export interface JTDValues {
	values: JTDSchema;
}

export interface JTDProperties {
	properties?: Record<string, JTDSchema>;
	optionalProperties?: Record<string, JTDSchema>;
}

export interface JTDDiscriminator {
	discriminator: string;
	mapping: Record<string, JTDProperties>;
}

export interface JTDRef {
	ref: string;
}

export interface JTDEmpty {}

export type JTDSchema =
	| JTDType
	| JTDEnum
	| JTDElements
	| JTDValues
	| JTDProperties
	| JTDDiscriminator
	| JTDRef
	| JTDEmpty;

// Type guards

export function isJTDType(schema: unknown): schema is JTDType {
	return typeof schema === "object" && schema !== null && "type" in schema;
}

export function isJTDEnum(schema: unknown): schema is JTDEnum {
	return typeof schema === "object" && schema !== null && "enum" in schema && Array.isArray(schema.enum);
}

export function isJTDElements(schema: unknown): schema is JTDElements {
	return typeof schema === "object" && schema !== null && "elements" in schema;
}

export function isJTDValues(schema: unknown): schema is JTDValues {
	return typeof schema === "object" && schema !== null && "values" in schema;
}

export function isJTDProperties(schema: unknown): schema is JTDProperties {
	return typeof schema === "object" && schema !== null && ("properties" in schema || "optionalProperties" in schema);
}

export function isJTDDiscriminator(schema: unknown): schema is JTDDiscriminator {
	return (
		typeof schema === "object" &&
		schema !== null &&
		"discriminator" in schema &&
		"mapping" in schema &&
		typeof schema.discriminator === "string" &&
		typeof schema.mapping === "object" &&
		schema.mapping !== null &&
		!Array.isArray(schema.mapping)
	);
}

export function isJTDRef(schema: unknown): schema is JTDRef {
	return typeof schema === "object" && schema !== null && "ref" in schema;
}

/** Per-form handlers for {@link visitJtd}; `empty` covers the empty form and anything unrecognized. */
export interface JTDVisitor<R> {
	type(schema: JTDType): R;
	enum(schema: JTDEnum): R;
	elements(schema: JTDElements): R;
	values(schema: JTDValues): R;
	properties(schema: JTDProperties): R;
	discriminator(schema: JTDDiscriminator): R;
	ref(schema: JTDRef): R;
	empty(): R;
}

/**
 * Dispatch `schema` to the visitor handler for its JTD form.
 * `typeFirst` checks the type form before enum/elements (TypeScript rendering order);
 * otherwise enum and elements win over a co-present `type` (JSON Schema conversion order).
 */
export function visitJtd<R>(schema: unknown, visitor: JTDVisitor<R>, typeFirst = false): R {
	if (typeFirst && isJTDType(schema)) return visitor.type(schema);
	if (isJTDEnum(schema)) return visitor.enum(schema);
	if (isJTDElements(schema)) return visitor.elements(schema);
	if (!typeFirst && isJTDType(schema)) return visitor.type(schema);
	if (isJTDValues(schema)) return visitor.values(schema);
	if (isJTDProperties(schema)) return visitor.properties(schema);
	if (isJTDDiscriminator(schema)) return visitor.discriminator(schema);
	if (isJTDRef(schema)) return visitor.ref(schema);
	return visitor.empty();
}
