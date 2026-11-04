import type { SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js';
/** Presentation only: never trim the raw snapshots used by quota/routing logic. */
export declare function visibleUsageWindows(provider: SubscriptionProvider, windows: UsageWindow[] | undefined, visibleModels: readonly string[] | undefined): UsageWindow[];
