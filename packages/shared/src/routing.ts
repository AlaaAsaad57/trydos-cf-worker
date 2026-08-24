import { readJsonCookie } from "./cookies";
import { COOKIE_NAMES, type ProxiedServer } from "./services";

/** Which backend answers a market request — gateway (guests) or core.
 *
 *  ⚠️ MIRRORS `trydos/utils/server/tokenManager.ts`. Both backends share one
 *  database and each verifies its own JWT, so this is **load steering, not
 *  authorization** — the original says so explicitly. A divergence here sends
 *  traffic to the wrong backend; it does not let anyone past a check. That is
 *  worth knowing before anyone "fixes" the two quirks preserved below. */

/** Paths the gateway serves for guest/allow-listed traffic. */
const GATEWAY_APIS = [
  "/auth/register-guest",
  "/mobile/home/currency",
  "/web/home/startingSettings",
  "/checklist",
  "/firebase_device_tokens/validate_token",
  "/firebase_device_tokens",
  "/cart/add",
  "/cart/update",
  "/cart/remove",
  "/cart/cart_shipping",
  "/cart/cart_overview",
  "/cart/convert_to_old",
  "/old-cart/get_old_cart",
  "/old-cart/hide",
  "/firebase_device_tokens/subscribe_topic",
  "/firebase_device_tokens/unsubscribe_topic",
  "/firebase_device_tokens/my_firebase_settings",
  "/firebase_device_tokens/change_country_language",
  "/firebase_device_tokens/update_whatsapp",
  "/firebase_device_tokens/update_email",
  "/firebase_device_tokens/update_firebase",
  "/firebase_device_tokens/update_notification_frequency",
  "/web/get-colors-and-sizes",
  "/web/notification_types",
  "/web/notification_types/customer-notification-to-choose",
  // ── Customer profile API migration (ClickUp 86ey26atu) ──
  // These four customer operations moved from the core "market" backend to the
  // store gateway. Rollback: comment out (or remove) this block to route them
  // back to BACKEND_URL (the core backend) — no caller change needed.
  "/customer/info",
  "/customer/update-profile",
  "/customer/update-name",
  "/customer/approve-policies",
];

// Gateway endpoints whose URL carries a trailing dynamic segment (e.g. a
// product slug), so the full path never `endsWith` a fixed string.
const GATEWAY_API_PREFIXES = [
  "/web/product/globalDetails/",
  "/web/product/qtyPriceDetails/",
  "/web/product/product-meta/",
];

/** Ported verbatim, including two quirks that are NOT bugs to fix here:
 *
 *   1. The "/checklist" test runs against the RAW url while everything below
 *      it uses the query-stripped one. Harmless — it is a startsWith, so a
 *      query string cannot affect it — but it is asymmetric, and copying the
 *      asymmetry is how the two files stay comparable.
 *   2. GATEWAY_API_PREFIXES is matched with `includes`, not `startsWith`,
 *      despite the original's comment saying "matched by prefix". So the
 *      segment matches anywhere in the path. Looser than it reads.
 *
 *  If either is worth changing, change it in trydos first and port the result.
 *
 *  Source: tokenManager.ts isGatewayApi() */
export const isGatewayApi = (url: string): boolean => {
  const normalizedUrl = url.split("?")?.[0] ?? "";
  if (url.startsWith("/checklist")) return true;
  if (GATEWAY_API_PREFIXES.some((prefix) => normalizedUrl.includes(prefix)))
    return true;
  return GATEWAY_APIS.some((endpoint) => normalizedUrl.endsWith(endpoint));
};

/** "Verified" = the User-Data profile carries a valid phone. Placeholder values
 *  written by guest flows are explicitly NOT valid.
 *
 *  Source: tokenManager.ts hasValidPhone() */
export const hasValidPhone = (userData: unknown): boolean => {
  const phone = (userData as { phone?: unknown } | null)?.phone;
  if (phone === undefined || phone === null || phone === 0 || phone === "0")
    return false;
  return String(phone).trim() !== "";
};

/** Evaluated fresh on EVERY request from the current User-Data cookie — no
 *  caching, no session stickiness. Malformed cookies fail open to guest
 *  routing rather than throwing.
 *
 *  Source: tokenManager.ts isVerifiedMarketUser() */
export const isVerifiedMarketUser = (jar: Map<string, string>): boolean => {
  try {
    return hasValidPhone(readJsonCookie(jar, COOKIE_NAMES.USER_DATA));
  } catch {
    return false;
  }
};

/** Backend base URLs, supplied as Worker secrets rather than process.env.
 *  Names match trydos's env vars so the two stay greppable together. */
export interface BackendEnv {
  BACKEND_URL?: string;
  GO_BACKEND_URL?: string;
  ELASTIC_BACKEND_URL?: string;
  NEXT_PUBLIC_CHAT_BACKEND_URL?: string;
  STORIES_BACKEND_URL?: string;
  COMMENT_BACKEND_URL?: string;
  WALLET_BACKEND_URL?: string;
}

/** Returns "" for a configured-but-missing env var, exactly as the original
 *  does; the caller treats an empty base as a proxy failure.
 *
 *  Source: tokenManager.ts getServerBaseUrl() */
export const resolveBaseUrl = (
  server: ProxiedServer,
  url: string,
  env: BackendEnv,
  jar: Map<string, string>,
): string => {
  switch (server) {
    case "market": {
      // Verified users (valid phone in User-Data) are served ENTIRELY by the
      // core backend — the gateway allow-list is bypassed for them.
      // Guests/tokenless visitors keep the URL-only routing below.
      const useGateway = !isVerifiedMarketUser(jar) && isGatewayApi(url);
      return (useGateway ? env.GO_BACKEND_URL : env.BACKEND_URL) || "";
    }
    case "market-dashboard":
      // URL-only routing — the user-based rule is market-only.
      return (isGatewayApi(url) ? env.GO_BACKEND_URL : env.BACKEND_URL) || "";
    case "elastic":
      return env.ELASTIC_BACKEND_URL || "";
    case "chat":
      return env.NEXT_PUBLIC_CHAT_BACKEND_URL || "";
    case "stories":
      return env.STORIES_BACKEND_URL || "";
    case "comments":
      return env.COMMENT_BACKEND_URL || "";
    case "wallet":
      return env.WALLET_BACKEND_URL || "";
    default:
      return "";
  }
};

/** Which cookie carries the credential for each backend.
 *
 *  Source: tokenManager.ts getTokenForServer() */
export const tokenForServer = (
  server: ProxiedServer,
  jar: Map<string, string>,
): string => {
  switch (server) {
    case "wallet":
      return jar.get(COOKIE_NAMES.WALLET_TOKEN) || "";
    case "comments":
      return jar.get(COOKIE_NAMES.USER_ID_HASH) || "";
    case "chat":
      return jar.get(COOKIE_NAMES.CHAT_TOKEN) || "";
    case "market":
    case "market-dashboard":
      // Single auth cookie: MARKET_TOKEN holds the guest OR logged-in JWT.
      return jar.get(COOKIE_NAMES.MARKET_TOKEN) || "";
    case "stories":
      return jar.get(COOKIE_NAMES.STORIES_TOKEN) || "";
    case "elastic":
      return "";
    default:
      return "";
  }
};

/** Source: tokenManager.ts buildProxyHeaders() */
export const buildProxyHeaders = (
  server: ProxiedServer,
  country: string,
  language: string,
  jar: Map<string, string>,
  sellerId?: string,
): Record<string, string> => {
  const token = tokenForServer(server, jar);
  const userChat = readJsonCookie<{ role_id?: string }>(
    jar,
    COOKIE_NAMES.USER_CHAT,
  );
  const roleId =
    typeof userChat === "object" && userChat !== null
      ? (userChat.role_id ?? "-1")
      : "-1";

  const headers: Record<string, string> = {
    accept: "application/json",
    lang: language,
    "Accept-Language": language,
    "x-lang": language,
    country,
    countryCode: country?.toUpperCase(),
    current_role_id: roleId,
  };

  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (sellerId) headers["X-Seller-ID"] = sellerId;

  return headers;
};
