/** The /api/proxy wire contract: opaque service tokens and the allowlist.
 *
 *  ⚠️ MIRRORS `trydos/utils/serviceTokens.ts` and the ALLOWED_SERVERS list in
 *  `trydos/utils/server/tokenManager.ts`. The browser sends these tokens, so
 *  both sides must agree exactly. Change one, change the other.
 *
 *  The forward map necessarily ships to the browser — the client has to know
 *  which token to send — so this is obfuscation, not access control. It raises
 *  the cost of casual reconnaissance; it does not secure the proxy. Copying it
 *  into this repo therefore leaks nothing that a page view does not. */

export type ProxiedServer =
  | "chat"
  | "market"
  | "stories"
  | "elastic"
  | "comments"
  | "wallet"
  | "market-dashboard";

export const SERVICE_TOKENS = Object.freeze({
  market: "vv7qsd",
  "market-dashboard": "k2muhz",
  chat: "p9xtrb",
  stories: "dw4nge",
  elastic: "hs6ljc",
  comments: "tn3ykf",
  wallet: "ge8zpm",
} as const);

const SERVICE_NAMES: Readonly<Record<string, ProxiedServer>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SERVICE_TOKENS).map(([name, token]) => [token, name]),
  ) as Record<string, ProxiedServer>,
);

/** Opaque wire token -> internal service name. Returns "" for unknown input. */
export const fromServiceToken = (token: string): string =>
  SERVICE_NAMES[token] ?? "";

const ALLOWED_SERVERS: readonly ProxiedServer[] = [
  "chat",
  "market",
  "stories",
  "elastic",
  "comments",
  "wallet",
  "market-dashboard",
];

export const isAllowedServer = (server: string): server is ProxiedServer =>
  (ALLOWED_SERVERS as readonly string[]).includes(server);

/** Cookie names, mirroring `trydos/utils/cookies/cookie-manager.ts`.
 *
 *  Only the ones the proxy reads are listed. USER_ID_HASH's value really is a
 *  long random string in the original — it is a deliberately unguessable
 *  cookie name, so it must be copied character for character. */
export const COOKIE_NAMES = Object.freeze({
  USER_DATA: "User-Data",
  USER_CHAT: "USER-CHAT",
  MARKET_TOKEN: "MARKET-TOKEN",
  CHAT_TOKEN: "CHAT-TOKEN",
  STORIES_TOKEN: "STORIES-TOKEN",
  WALLET_TOKEN: "rdb_at",
  USER_ID_HASH:
    "x7k9m2p4q8r1s5t3u6v2w9y4z7a1b5c8d2e6f9g3h7j1k4l8m2n5p9q3r6s1t4u7v2w5x8y1z4a7b2c5d8e1f4g7h2j5k8l1m4n7o2p5q8r1s4t7u2v5w8x1y4z7",
} as const);
