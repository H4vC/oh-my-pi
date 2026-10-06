/** Length of the longest run of consecutive backticks in `value` (0 when it has none). */
export function longestBacktickRun(value: string): number {
	let longestRun = 0;
	let run = 0;
	for (let index = 0; index < value.length; index++) {
		if (value.charCodeAt(index) === 0x60) {
			run++;
			if (run > longestRun) longestRun = run;
		} else {
			run = 0;
		}
	}
	return longestRun;
}

/** Pick a Markdown fence that cannot occur in the supplied exact value. */
export function markdownFenceFor(value: string): string {
	return "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
}
