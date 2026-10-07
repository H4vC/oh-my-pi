/** Pick a Markdown fence that cannot occur in the supplied exact value. */
export function markdownFenceFor(value: string): string {
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
	return "`".repeat(Math.max(3, longestRun + 1));
}
