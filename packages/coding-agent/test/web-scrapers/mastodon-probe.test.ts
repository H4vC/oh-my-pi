import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleMastodon } from "@oh-my-pi/pi-coding-agent/web/scrapers/mastodon";

describe("mastodon instance probe", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not let one caller's abort decide the shared probe verdict for concurrent callers", async () => {
		const host = "probe-abort.mastodon.test";
		const instance = Promise.withResolvers<void>();
		let statusRequested = false;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/v1/instance")) {
				const signal = init?.signal;
				await new Promise<void>((resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					instance.promise.then(resolve);
				});
				return Response.json({ uri: host });
			}
			statusRequested = true;
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		const abortFirst = new AbortController();
		const first = handleMastodon(`https://${host}/@alice/1`, 20, abortFirst.signal);
		const second = handleMastodon(`https://${host}/@alice/1`, 20);
		abortFirst.abort();
		expect(await first).toBeNull();
		instance.resolve();

		expect(await second).toBeNull();
		// The second caller saw a positive verdict and went on to fetch the status.
		expect(statusRequested).toBe(true);
	});
});
