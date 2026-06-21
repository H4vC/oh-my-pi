import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { JsDisplayOutput } from "../../eval/js/shared/types";
import { resizeImage } from "../../utils/image-resize";
import { formatScreenshot } from "../render-utils";
import type { RunResultOk, ScreenshotResult, SessionSnapshot } from "./tab-protocol";

export type ScreenshotImageFormat = "png" | "jpeg" | "webp";

export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function cloneSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		structuredClone(value);
		return value;
	} catch {}
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {}
	return String(value);
}

export function pushDisplay(displays: RunResultOk["displays"], output: JsDisplayOutput): void {
	if (output.type === "image") {
		displays.push({ type: "image", data: output.data, mimeType: output.mimeType });
		return;
	}
	if (output.type === "json") {
		displays.push({ type: "text", text: safeJsonStringify(output.data) });
		return;
	}
	displays.push({ type: "text", text: safeJsonStringify(output.event) });
}

export function imageFormatForPath(filePath: string): ScreenshotImageFormat {
	switch (path.extname(filePath).toLowerCase()) {
		case ".webp":
			return "webp";
		case ".jpg":
		case ".jpeg":
			return "jpeg";
		default:
			return "png";
	}
}

export async function saveBrowserScreenshot(opts: {
	buffer: Buffer;
	captureMime: "image/png" | "image/jpeg";
	displays: RunResultOk["displays"];
	screenshots: ScreenshotResult[];
	session: SessionSnapshot;
	explicitPath?: string;
	returnedPath?: string;
	silent?: boolean;
	fullDimensionFormats?: readonly ScreenshotImageFormat[];
}): Promise<ScreenshotResult> {
	const { buffer, captureMime, displays, screenshots, session, explicitPath, returnedPath } = opts;
	const resized = await resizeImage(
		{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
		{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
	);
	const pathFormat = explicitPath ? imageFormatForPath(explicitPath) : "png";
	const saveFullRes = !!(explicitPath || session.browserScreenshotDir || returnedPath);
	let savedBuffer: Buffer;
	let savedMimeType: string;
	if (pathFormat === "webp") {
		savedBuffer = Buffer.from(await new Bun.Image(buffer).webp({ quality: 80 }).bytes());
		savedMimeType = "image/webp";
	} else if (pathFormat === "jpeg" && captureMime !== "image/jpeg") {
		savedBuffer = Buffer.from(await new Bun.Image(buffer).jpeg({ quality: 80 }).bytes());
		savedMimeType = "image/jpeg";
	} else if (saveFullRes) {
		savedBuffer = buffer;
		savedMimeType = captureMime;
	} else {
		savedBuffer = resized.buffer as Buffer;
		savedMimeType = resized.mimeType;
	}
	const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
	const dest =
		explicitPath ??
		(session.browserScreenshotDir
			? path.join(
					session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: (returnedPath ?? path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`)));
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	await Bun.write(dest, savedBuffer);
	const reportOriginalSize = opts.fullDimensionFormats?.includes(pathFormat) ?? false;
	const info: ScreenshotResult = {
		dest,
		mimeType: savedMimeType,
		bytes: savedBuffer.length,
		width: reportOriginalSize ? resized.originalWidth : resized.width,
		height: reportOriginalSize ? resized.originalHeight : resized.height,
	};
	screenshots.push(info);
	if (!opts.silent) {
		const lines = formatScreenshot({
			saveFullRes,
			savedMimeType,
			savedByteLength: savedBuffer.length,
			dest,
			resized,
		});
		displays.push({ type: "text", text: lines.join("\n") });
		displays.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
	}
	return info;
}
