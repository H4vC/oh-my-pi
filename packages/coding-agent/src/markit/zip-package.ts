import {
	type ArchiveReader,
	assertInMemorySize,
	DEFAULT_ARCHIVE_LIMITS,
	openArchive,
	UTF8_DECODER,
} from "@oh-my-pi/pi-utils/ar";

/**
 * A ZIP-based document package (OOXML, EPUB) whose members are inflated only
 * when read. Lookups use exact member paths, so a converter sees the same
 * members a fully materialized `path → bytes` map would expose. Bytes inflated
 * across all reads are capped like a fully materialized archive, so a crafted
 * package cannot amplify past the in-memory limit one member at a time.
 */
export class ZipPackage {
	#archive: ArchiveReader;
	#members = new Set<string>();
	#limits: typeof DEFAULT_ARCHIVE_LIMITS;
	#inflated = 0;

	constructor(archive: ArchiveReader, maxTotalBytes = DEFAULT_ARCHIVE_LIMITS.maxInMemorySize) {
		this.#archive = archive;
		this.#limits = { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: maxTotalBytes };
		for (const entry of archive.indexEntries()) {
			if (!entry.isDirectory) this.#members.add(entry.path);
		}
	}

	/** Index a ZIP buffer without inflating any member. */
	static async open(bytes: Uint8Array, maxTotalBytes?: number): Promise<ZipPackage> {
		return new ZipPackage(await openArchive({ bytes, format: "zip" }), maxTotalBytes);
	}

	/** Exact paths of every file member. */
	get members(): ReadonlySet<string> {
		return this.#members;
	}

	/** Inflate one member, or `undefined` when absent. Throws once total inflated bytes exceed the cap. */
	async readBytes(memberPath: string): Promise<Uint8Array | undefined> {
		if (!this.#members.has(memberPath)) return undefined;
		const { bytes } = await this.#archive.readFile(memberPath);
		this.#inflated += bytes.length;
		assertInMemorySize(this.#inflated, this.#limits);
		return bytes;
	}

	/** Inflate one member as UTF-8 text, or `undefined` when absent. */
	async readText(memberPath: string): Promise<string | undefined> {
		const bytes = await this.readBytes(memberPath);
		return bytes ? UTF8_DECODER.decode(bytes) : undefined;
	}
}
