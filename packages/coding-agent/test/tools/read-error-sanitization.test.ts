import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";

describe("readToolRenderer error sanitization", () => {
	it("strips Windows CRLF and expands tabs in ssh failure output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		// Windows ssh emits CRLF; a raw CR styled inside the color wrap rides
		// past output-block trimming (it trims after wrapping) and moves the
		// terminal cursor mid-row, tearing the framed block.
		const component = readToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: "Failed to start SSH master for can.internal: The fingerprint for the ED25519 key sent by the remote host is\r\nSHA256:abc\tdef\r\nAdd correct host key in /root/.ssh/known_hosts to get rid of this message.\r\nHost key verification failed.",
					},
				],
				isError: true,
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "ssh://can.internal/root/arc-smp-values.yaml" },
		);

		const raw = component.render(100).join("\n");
		expect(raw).not.toContain("\t");
		expect(raw).not.toContain("\r");
		const stripped = raw
			.split("\n")
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("SHA256:abc");
		expect(stripped).toContain("Host key verification failed.");
	});

	it("sanitizes URL read errors the same way", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "fetch failed:\tconn reset\r\nby peer" }],
				isError: true,
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/file" },
		);

		const raw = component.render(100).join("\n");
		expect(raw).not.toContain("\t");
		expect(raw).not.toContain("\r");
		expect(Bun.stripANSI(raw)).toContain("fetch failed:");
	});
});
