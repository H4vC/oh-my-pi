/**
 * `useQuery`: cached, live-revalidating data fetching for dashboard pages.
 *
 * - Results are cached per key for the page session, so revisiting a page or
 *   a range renders instantly from memory. Multi-MB detail payloads (traces,
 *   request details) live in their own small LRUs so they don't pile up.
 * - A key change keeps the previous key's data on screen (`stale: true`) until
 *   the new data lands, so charts morph instead of flashing skeletons.
 * - Every cached entry remembers the live data version it was fetched at
 *   (see `useLiveVersion`); when the version advances, enabled queries refetch
 *   in the background, throttled so a burst of ingest batches costs one request.
 * - Identical keys share one in-flight request; it is aborted once no query
 *   waits for it any more.
 * - Fetchers receive the cached data for their key, so conditional requests
 *   can resolve to that same object; an unchanged reference does not re-render.
 */

import { startTransition, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { currentLiveVersion, useLiveVersion } from "./live";

interface CacheEntry {
	data: unknown;
	updatedAt: number;
	version: number;
}

interface CacheBucket {
	entries: Map<string, CacheEntry>;
	limit: number;
}

interface Inflight {
	promise: Promise<unknown>;
	controller: AbortController;
	/** Queries (and prefetches) waiting on this request. */
	waiters: number;
}

/**
 * Handed to every fetcher. Deliberately not generic in the data type, so
 * `useQuery` still infers it from the fetcher's return type.
 */
export interface QueryFetchContext {
	/** Aborted once no query waits for this request any more. */
	signal: AbortSignal;
	/** Cached data for this key (same type the fetcher returns), for conditional revalidation; `undefined` on first load. */
	previous: unknown;
}

/** Minimum spacing between live-driven refetches of one query. */
const LIVE_REFETCH_THROTTLE_MS = 1500;

const defaultBucket: CacheBucket = { entries: new Map(), limit: 128 };
/** Full session traces: MBs each, at most a few worth keeping. */
const traceBucket: CacheBucket = { entries: new Map(), limit: 4 };
/** Request detail payloads (full prompts and responses). */
const requestBucket: CacheBucket = { entries: new Map(), limit: 16 };

const inflight = new Map<string, Inflight>();

function bucketFor(key: string): CacheBucket {
	if (key.startsWith('["trace",')) return traceBucket;
	if (key.startsWith('["request",')) return requestBucket;
	return defaultBucket;
}

export interface QueryOptions {
	/** Only enabled queries fetch; hidden (kept-alive) pages pass `false`. Default true. */
	enabled?: boolean;
	/** Additionally refetch on this interval while enabled and the tab is visible. */
	pollMs?: number;
}

export interface QueryResult<T> {
	/** Data for the current key, or the previous key's data while it loads. */
	data: T | null;
	error: Error | null;
	/** Nothing to show yet (first load of this query). */
	loading: boolean;
	/** `data` belongs to a previous key; the current key is still loading. */
	stale: boolean;
	/** A background request is in flight. */
	refreshing: boolean;
	/** When the shown data was fetched. */
	updatedAt: number | null;
	refetch: () => void;
}

function remember(key: string, entry: CacheEntry): void {
	const { entries, limit } = bucketFor(key);
	entries.delete(key);
	entries.set(key, entry);
	if (entries.size > limit) {
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) entries.delete(oldest);
	}
}

/**
 * Fetch into the cache, sharing one request among concurrent callers of the
 * same key. The caller holds one waiter on the returned request; pair with
 * {@link release}.
 */
function load(key: string, fetcher: (context: QueryFetchContext) => Promise<unknown>): Inflight {
	const pending = inflight.get(key);
	if (pending) {
		pending.waiters++;
		return pending;
	}
	const controller = new AbortController();
	const version = currentLiveVersion();
	const previous = bucketFor(key).entries.get(key)?.data;
	const request: Inflight = {
		promise: fetcher({ signal: controller.signal, previous })
			.then(data => {
				remember(key, { data, updatedAt: Date.now(), version });
				return data;
			})
			.finally(() => {
				if (inflight.get(key) === request) inflight.delete(key);
			}),
		controller,
		waiters: 1,
	};
	inflight.set(key, request);
	return request;
}

/** Drop one waiter; the last one out aborts the request. */
function release(key: string, request: Inflight): void {
	request.waiters--;
	if (request.waiters > 0) return;
	if (inflight.get(key) === request) inflight.delete(key);
	request.controller.abort();
}

/**
 * Warm the cache for a key the user is likely to open next. No-op if cached for this version.
 * @deprecated Unused by the dashboard; render the target page's `useQuery` instead. Will be removed in the next major.
 */
export function prefetchQuery<T>(key: readonly unknown[], fetcher: () => Promise<T>, version: number): void {
	const keyString = JSON.stringify(key);
	const entry = bucketFor(keyString).entries.get(keyString);
	if (entry && entry.version >= version) return;
	// Never released: a prefetch runs to completion.
	load(keyString, fetcher).promise.catch(() => {});
}

export function useQuery<T>(
	key: readonly unknown[],
	fetcher: (context: QueryFetchContext) => Promise<T>,
	options?: QueryOptions,
): QueryResult<T> {
	const keyString = JSON.stringify(key);
	const enabled = options?.enabled ?? true;
	const pollMs = options?.pollMs;
	const version = useLiveVersion(enabled);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [error, setError] = useState<{ key: string; error: Error } | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const keyRef = useRef(keyString);
	keyRef.current = keyString;
	const lastShown = useRef<{ key: string; data: unknown; updatedAt: number } | null>(null);
	const lastFetchAt = useRef(0);
	/** The request this query currently waits on. */
	const waiting = useRef<{ key: string; request: Inflight } | null>(null);

	const run = useCallback((targetKey: string) => {
		lastFetchAt.current = Date.now();
		const current = waiting.current;
		if (current?.key === targetKey && inflight.get(targetKey) === current.request) return;
		const shownBefore = bucketFor(targetKey).entries.get(targetKey)?.data;
		setRefreshing(true);
		const request = load(targetKey, context => fetcherRef.current(context));
		waiting.current = { key: targetKey, request };
		// Join the new request before leaving the old one, so a shared request isn't aborted in between.
		if (current) release(current.key, current.request);
		request.promise
			.then(data => {
				if (keyRef.current !== targetKey) return;
				// Revalidated to the very same object: nothing on screen changes.
				if (data === shownBefore) {
					setError(prev => (prev === null ? prev : null));
					return;
				}
				startTransition(() => {
					setError(null);
					rerender();
				});
			})
			.catch((err: unknown) => {
				if (keyRef.current !== targetKey || request.controller.signal.aborted) return;
				setError({ key: targetKey, error: err instanceof Error ? err : new Error(String(err)) });
			})
			.finally(() => {
				if (waiting.current?.request === request) waiting.current = null;
				if (keyRef.current === targetKey) setRefreshing(false);
			});
	}, []);

	// Leaving: stop waiting so an abandoned multi-MB fetch can be aborted.
	useEffect(
		() => () => {
			const current = waiting.current;
			waiting.current = null;
			if (current) release(current.key, current.request);
		},
		[],
	);

	// Fetch on key change / enable / data-version bump when the cache is behind.
	useEffect(() => {
		if (!enabled) return;
		const entry = bucketFor(keyString).entries.get(keyString);
		if (entry && entry.version >= version) return;
		const wait = entry ? lastFetchAt.current + LIVE_REFETCH_THROTTLE_MS - Date.now() : 0;
		if (wait <= 0) {
			run(keyString);
			return;
		}
		const timer = setTimeout(() => run(keyString), wait);
		return () => clearTimeout(timer);
	}, [keyString, enabled, version, run]);

	useEffect(() => {
		if (!enabled || !pollMs) return;
		const interval = setInterval(() => {
			if (!document.hidden) run(keyRef.current);
		}, pollMs);
		return () => clearInterval(interval);
	}, [enabled, pollMs, run]);

	const refetch = useCallback(() => run(keyRef.current), [run]);

	const entry = bucketFor(keyString).entries.get(keyString);
	if (entry) lastShown.current = { key: keyString, data: entry.data, updatedAt: entry.updatedAt };
	const shown = lastShown.current;
	const currentError = error?.key === keyString ? error.error : null;

	return {
		data: (shown?.data as T | undefined) ?? null,
		error: currentError,
		loading: !shown && !currentError,
		stale: !!shown && shown.key !== keyString,
		refreshing,
		updatedAt: shown?.updatedAt ?? null,
		refetch,
	};
}
