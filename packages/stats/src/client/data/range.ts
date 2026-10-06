/**
 * Time-range metadata shared by every page: labels, the server's span and
 * bucket size for the range ({@link RANGE_WINDOWS}), tick formatting, and the
 * contiguous bucket axis charts plot against.
 */

import { format } from "@oh-my-pi/pi-utils/dates";
import { DAY_MS, HOUR_MS, RANGE_WINDOWS, type TimeRange } from "../types";

export interface RangeMeta {
	/** Short selector label ("24h"). */
	label: string;
	/** Prose label for subtitles ("the last 24 hours"). */
	windowLabel: string;
	/** Span covered by the range; `null` for all time. */
	spanMs: number | null;
	/** Bucket size of the server's primary time series for this range. */
	bucketMs: number;
}

const RANGE_META: Record<TimeRange, RangeMeta> = {
	"1h": { label: "1h", windowLabel: "the last hour", ...RANGE_WINDOWS["1h"] },
	"24h": { label: "24h", windowLabel: "the last 24 hours", ...RANGE_WINDOWS["24h"] },
	"7d": { label: "7d", windowLabel: "the last 7 days", ...RANGE_WINDOWS["7d"] },
	"30d": { label: "30d", windowLabel: "the last 30 days", ...RANGE_WINDOWS["30d"] },
	"90d": { label: "90d", windowLabel: "the last 90 days", ...RANGE_WINDOWS["90d"] },
	all: { label: "All", windowLabel: "all time", ...RANGE_WINDOWS.all },
};

const MAX_BUCKETS = 1500;

/** Ranges in selector order. */
export const TIME_RANGES: readonly TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

export function rangeMeta(range: TimeRange): RangeMeta {
	return RANGE_META[range];
}

/** Tick/tooltip label for a bucket start, precise enough for the bucket size. */
export function formatBucket(timestamp: number, bucketMs: number): string {
	if (bucketMs < DAY_MS) return format(new Date(timestamp), bucketMs < HOUR_MS ? "HH:mm" : "MMM d HH:mm");
	return format(new Date(timestamp), "MMM d");
}

/** Compact axis tick for a bucket start. */
export function formatTick(timestamp: number, bucketMs: number): string {
	if (bucketMs < DAY_MS) return format(new Date(timestamp), "HH:mm");
	return format(new Date(timestamp), "MMM d");
}

/**
 * Contiguous, ascending bucket starts covering `range`, aligned like the
 * server's `(timestamp / bucketMs) * bucketMs`. For all time the axis starts at
 * the earliest data point, so gaps between sessions still render as zeros;
 * it is capped at {@link MAX_BUCKETS} so a stray epoch-zero timestamp cannot
 * explode the axis into decades of empty days.
 */
export function bucketAxis(
	range: TimeRange,
	dataTimestamps: Iterable<number>,
	bucketMs = RANGE_META[range].bucketMs,
	now = Date.now(),
): number[] {
	const last = Math.floor(now / bucketMs) * bucketMs;
	const span = RANGE_META[range].spanMs;
	let first: number;
	if (span !== null) {
		first = Math.floor((now - span) / bucketMs) * bucketMs;
	} else {
		first = last;
		for (const ts of dataTimestamps) if (ts < first) first = ts;
		first = Math.floor(first / bucketMs) * bucketMs;
	}
	first = Math.max(first, last - (MAX_BUCKETS - 1) * bucketMs);
	const buckets: number[] = [];
	for (let t = first; t <= last; t += bucketMs) buckets.push(t);
	return buckets;
}
