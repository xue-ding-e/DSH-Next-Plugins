/**
 * Quota tracking for pool members: polls the providers' usage endpoints
 * (the same normalized `ProviderUsage` shape the Settings page consumes) and
 * turns the windows into a scheduling score.
 *
 * The score is a REQUIRED BURN RATE: the fraction of the window that must be
 * consumed per millisecond for the quota to be exactly used up at reset time
 * (`remaining / timeUntilReset`). Subscription quota does not roll over, so a
 * window about to reset with plenty left is the most urgent to spend — the
 * `quota_aware` strategy therefore prefers the highest-urgency member, which
 * over time converges on every window hitting zero right at its reset.
 */
import type { ProviderUsage } from './common.js';
import type { ProviderId } from '../auth/store.js';
import type { ConcretePoolMember } from './pool-family.js';
/** Near-full members are tried only after members below this fill level. */
export declare const QUOTA_FULL_PERCENT = 95;
/** Exhausted subscription windows must not silently spill over into paid credits. */
export declare const QUOTA_EXHAUSTED_PERCENT = 100;
/** How long a usage snapshot is trusted before a background refresh. */
export declare const USAGE_TTL_MS: number;
/** The scheduling view of one member's quota. */
export interface MemberQuota {
    /** False when a window is near-full or the login is gone. */
    available: boolean;
    /** A known exhausted window: exclude even if the upstream would accept paid credits. */
    exhausted?: true;
    /** Required burn rate (fraction of window per ms); 0 when unknown. */
    urgency: number;
    /** Epoch ms of the snapshot this was computed from; 0 when none. */
    fetchedAt: number;
}
/**
 * Per-ACCOUNT usage snapshots with in-flight dedupe and
 * stale-while-revalidate refresh. Providers without a usage endpoint
 * (copilot) resolve no fetcher and score a constant zero urgency — which
 * naturally ranks them behind every measured member. Fetchers are resolved
 * lazily per (provider, account) so accounts added after startup join
 * tracking on their first score.
 */
export declare class PoolUsageTracker {
    private readonly fetcherFor;
    private readonly ttlMs;
    private readonly entries;
    private readonly inflight;
    constructor(fetcherFor: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined, ttlMs?: number);
    /**
     * The quota view of one member. A cold cache awaits the first fetch; a
     * stale non-exhausted snapshot answers immediately while refreshing in the
     * background. Exhausted snapshots await their expired-cache refresh so a
     * reset can restore routing on this call. A live failure cooldown never
     * triggers another fetch.
     *
     * Failures discard stale urgency but preserve known exhaustion: an outage
     * must not turn a blocked subscription into permission to spend credits.
     * Only a successful usage lookup (or explicit invalidation) clears it.
     * @param member - the pool member to score (account resolved).
     * @returns availability plus the urgency score.
     */
    quotaFor(member: ConcretePoolMember): Promise<MemberQuota>;
    /** Keep a known credit-spending risk blocked through usage-endpoint failures. */
    private failedQuota;
    /**
     * Same cache as {@link quotaFor}, for direct display (the Settings page):
     * the raw snapshot, or the original fetch error, instead of a routing
     * score.
     * @param provider - the account's provider.
     * @param account - the account key.
     * @param force - bypass a fresh cached SNAPSHOT for an honest re-check (the
     *   manual Refresh button). A live failure cooldown is never bypassed —
     *   retrying through it is exactly what turns a 429 into a permanent
     *   lockout, so even a forced call still answers from the negative cache.
     * @returns `{ supported: false }` when the provider has no usage fetcher.
     */
    snapshotFor(provider: ProviderId, account: string, force?: boolean): Promise<ProviderUsage>;
    /** Recheck after an inference quota failure without erasing another model lane's exhaustion. */
    expire(provider: ProviderId, account: string): void;
    /** Drop cached snapshots: one account, or a whole provider when `account` is omitted. */
    invalidate(provider: ProviderId, account?: string): void;
    /**
     * Run (or join) the single in-flight fetch for one account key, caching
     * either outcome. A missing/invalid credential is deliberately NOT
     * negative-cached: it costs no network round trip (the session lookup
     * fails before the request goes out) and re-checking live means the
     * member rejoins routing the instant its login is fixed, rather than
     * waiting out a stale cooldown.
     */
    private refresh;
    /** Score one member against a snapshot's windows. */
    private score;
}
