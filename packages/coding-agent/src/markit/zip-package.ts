import { type ArchiveReader, openArchive, UTF8_DECODER } from "@oh-my-pi/pi-utils/ar";

/**
 * A ZIP-based document package (OOXML, EPUB) whose members are inflated only
 * when read. Lookups use exact member paths, so a converter sees the same
 * members a fully materialized `path → bytes` map would expose.
 */
export class ZipPackage {
	#archive: ArchiveReader;
	#members = new Set<string>();

	constructor(archive: ArchiveReader) {
		this.#archive = archive;
		for (const entry of archive.indexEntries()) {
			if (!entry.isDirectory) this.#members.add(entry.path);
		}
	}

	/** Index a ZIP buffer without inflating any member. */
	static async open(bytes: Uint8Array): Promise<ZipPackage> {
		return new ZipPackage(await openArchive({ bytes, format: "zip" }));
	}

	/** Exact paths of every file member. */
	get members(): ReadonlySet<string> {
		return this.#members;
	}

	/** Inflate one member, or `undefined` when absent. */
	async readBytes(memberPath: string): Promise<Uint8Array | undefined> {
		if (!this.#members.has(memberPath)) return undefined;
		return (await this.#archive.readFile(memberPath)).bytes;
	}

	/** Inflate one member as UTF-8 text, or `undefined` when absent. */
	async readText(memberPath: string): Promise<string | undefined> {
		const bytes = await this.readBytes(memberPath);
		return bytes ? UTF8_DECODER.decode(bytes) : undefined;
	}
}
