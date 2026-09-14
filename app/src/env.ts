/**
 * The pinned hosted deployment. These three origins are the complete
 * `connect-src` allowlist in `app/vercel.json`; adding an origin here without
 * adding it there produces a page that fails closed at the browser.
 */
export const convexDeploymentUrl = "https://qualified-hummingbird-537.convex.cloud";
export const convexWebSocketUrl = "wss://qualified-hummingbird-537.convex.cloud";
export const convexSiteUrl = "https://qualified-hummingbird-537.convex.site";

/** The only account key version this authority has ever issued. */
export const accountKeyVersion = 1;

/** Convex Auth provider id for the hosted one-time-code flow. */
export const otpProviderId = "hra-control-plane-otp-v1";

/** Presence heartbeat cadence while the document is visible. */
export const presenceHeartbeatMs = 30_000;

/** How long a submitted remote command stays executable. */
export const commandLifetimeMs = 5 * 60 * 1_000;

/** Convex page bound shared by every listing this app performs. */
export const pageSize = 100;

/** How many detail chunks the live tail subscribes to. */
export const liveTailChunkLimit = 24;

/** How many compact chunks a grid card subscribes to for its prompt and interactions. */
export const compactTailChunkLimit = 6;

/** How often the enrollment screen re-reads its own registration. */
export const enrollmentPollMs = 3_000;
