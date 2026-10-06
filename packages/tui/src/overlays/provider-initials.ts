/**
 * A provider scope mark's initials: the first letters of the first two words
 * (`amazon-bedrock` → `AB`, `Claude Code` → `CC`), or a single word's first
 * letter capitalized plus its second as written (`anthropic` → `An`).
 */
export function providerInitials(label: string): string {
	const words = label.split(/[-_\s.()]+/).filter(word => word.length > 0);
	if (words.length >= 2) return `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase();
	const word = words[0] ?? label;
	return `${word.charAt(0).toUpperCase()}${word.charAt(1)}`;
}
