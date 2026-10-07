/**
 * Typed declaration for the generated models.interned.json (see scripts/intern-models.ts).
 * Rows carry `compat` / `thinking` / `identity` as indexes into `profiles`.
 */
declare const interned: {
	readonly profiles: {
		readonly compat: readonly object[];
		readonly thinking: readonly object[];
		readonly identity: readonly object[];
	};
	readonly models: {
		[provider: string]: {
			[modelId: string]: Record<string, unknown>;
		};
	};
};
export default interned;
