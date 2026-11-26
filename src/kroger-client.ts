/**
 * kroger-client.ts — Kroger API wrapper for Cloudflare Workers
 *
 * This is a TypeScript rewrite of the Python kroger API logic.
 * Instead of a third-party library, we use the built-in `fetch()` function
 * that Cloudflare Workers provide natively (no imports needed).
 *
 * Analogy: if the Python server was a phone operator dialing Kroger's number
 * for you, this class is the same operator — just running on a different phone
 * system (Workers instead of your laptop).
 */

import type {
  Env,
  KrogerTokenResponse,
  KrogerProductSearchResponse,
  StoredKrogerToken,
  CleanProduct,
} from "./types";
import { LEGACY_KROGER_USER_TOKEN_KEY, krogerUserTokenKey } from "./security";

const KROGER_API_BASE = "https://api.kroger.com/v1";
const KROGER_TOKEN_URL = `${KROGER_API_BASE}/connect/oauth2/token`;

/**
 * Sent on every Kroger request. Kroger's API sits behind Akamai, which has
 * returned 403 "Access Denied" to this Worker's requests; identifying the
 * client explicitly rules out a missing User-Agent as the cause.
 */
export const KROGER_DEFAULT_HEADERS = {
  "User-Agent": "mcp-kroger/1.0 (+https://github.com/mleary/mcp-kroger)",
  Accept: "application/json",
};

/**
 * How long a stored Kroger user token stays in KV without being used.
 *
 * The access token inside it only lasts ~30 minutes, but the refresh token lasts
 * far longer, and losing it is what forces a full browser re-auth. So the KV entry
 * must outlive the access token by a wide margin. Every refresh rewrites the entry
 * and resets this clock; Kroger remains the authority on when the refresh token
 * itself stops working.
 */
const KROGER_USER_TOKEN_KV_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days

const REAUTH_HINT = "Use reauthenticate_tool in Claude to get a fresh Kroger authorization link.";

/** Persist a Kroger user token for an MCP account. */
export async function storeKrogerUserToken(
  env: Pick<Env, "TOKEN_STORE">,
  accountId: string,
  token: KrogerTokenResponse
): Promise<StoredKrogerToken> {
  const stored: StoredKrogerToken = { ...token, stored_at: Date.now() };
  await env.TOKEN_STORE.put(krogerUserTokenKey(accountId), JSON.stringify(stored), {
    expirationTtl: KROGER_USER_TOKEN_KV_TTL_SECONDS,
  });
  return stored;
}

// ─────────────────────────────────────────────────────────────────────────────
// KrogerClient class
//
// In TypeScript, a `class` bundles related data (properties) and behaviour
// (methods) together — same concept as Python classes.
// ─────────────────────────────────────────────────────────────────────────────
export class KrogerClient {
  private env: Env;
  private accountId: string;

  // `accountId` namespaces stored Kroger OAuth tokens by the authenticated MCP user.
  constructor(env: Env, accountId: string) {
    this.env = env;
    this.accountId = accountId;
  }

  private userTokenKey(): string {
    return krogerUserTokenKey(this.accountId);
  }

  // ── Token helpers ───────────────────────────────────────────────────────────

  /**
   * Base64-encode "clientId:clientSecret" for the HTTP Basic Auth header.
   * btoa() is a built-in Web API available in Workers (no imports needed).
   */
  private basicAuthHeader(): string {
    return `Basic ${btoa(`${this.env.KROGER_CLIENT_ID}:${this.env.KROGER_CLIENT_SECRET}`)}`;
  }

  /**
   * Fetch a short-lived "client credentials" token.
   * This token gives us read access to the product catalogue — no user login needed.
   * Expires in ~30 minutes; we fetch a fresh one per request (simple & safe).
   */
  async getClientToken(scope = "product.compact"): Promise<string> {
    const response = await fetch(KROGER_TOKEN_URL, {
      method: "POST",
      headers: {
        ...KROGER_DEFAULT_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kroger token error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as KrogerTokenResponse;
    return data.access_token;
  }

  /**
   * Load the stored Kroger *user* OAuth token from KV.
   * This token is needed for cart operations (it has the user's identity).
   * Returns null if no token is stored yet — user must visit /auth/kroger first.
   */
  async getUserToken(): Promise<StoredKrogerToken | null> {
    const raw =
      (await this.env.TOKEN_STORE.get(this.userTokenKey())) ??
      (await this.env.TOKEN_STORE.get(LEGACY_KROGER_USER_TOKEN_KEY));
    if (!raw) return null;
    return JSON.parse(raw) as StoredKrogerToken;
  }

  /**
   * Refresh the user token using the refresh_token grant.
   * Kroger user tokens expire in 30 minutes; refresh tokens last much longer.
   * Returns the new access token, or throws if refresh fails.
   */
  async refreshUserToken(refreshToken: string): Promise<string> {
    const response = await fetch(KROGER_TOKEN_URL, {
      method: "POST",
      headers: {
        ...KROGER_DEFAULT_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Kroger token refresh failed (${response.status}): ${body}. ${REAUTH_HINT}`
      );
    }

    const data = (await response.json()) as KrogerTokenResponse;

    // If Kroger rotates the refresh token, store the new one. If it doesn't send
    // one back, keep the one we just used, or the next refresh has nothing to use.
    await storeKrogerUserToken(this.env, this.accountId, {
      ...data,
      refresh_token: data.refresh_token ?? refreshToken,
    });

    return data.access_token;
  }

  /**
   * Get a valid user access token, auto-refreshing if needed.
   * Think of this like a smart key-holder that renews the key before it expires.
   */
  async getValidUserToken(): Promise<string> {
    const stored = await this.getUserToken();
    if (!stored) {
      throw new Error(`No Kroger user token found. ${REAUTH_HINT}`);
    }

    // Check if token is about to expire (within 5 minutes)
    const ageMs = Date.now() - stored.stored_at;
    const expiresInMs = (stored.expires_in ?? 1800) * 1000;
    const isExpiringSoon = ageMs > expiresInMs - 5 * 60 * 1000;

    if (isExpiringSoon && stored.refresh_token) {
      return this.refreshUserToken(stored.refresh_token);
    }

    if (isExpiringSoon) {
      throw new Error(
        `Kroger user token has expired and no refresh token is available. ${REAUTH_HINT}`
      );
    }

    return stored.access_token;
  }

  // ── Product search ──────────────────────────────────────────────────────────

  /**
   * Search the Kroger product catalogue.
   * Equivalent to the Python `product_search_tool`.
   */
  async searchProducts(query: string, limit = 5): Promise<CleanProduct[]> {
    const token = await this.getClientToken("product.compact");

    const params = new URLSearchParams({
      "filter.term": query,
      "filter.locationId": this.env.KROGER_STORE_ID,
      "filter.limit": String(Math.min(limit, 50)), // Kroger caps at 50
    });

    const response = await fetch(`${KROGER_API_BASE}/products?${params}`, {
      headers: { ...KROGER_DEFAULT_HEADERS, Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kroger product search failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as KrogerProductSearchResponse;
    const products = data.data ?? [];

    // Clean up the response — only return the fields Claude actually needs
    return products.map((p): CleanProduct => {
      const item = p.items?.[0]; // usually just one item size per product listing
      return {
        description: p.description ?? "Unknown",
        brand: p.brand ?? "Unknown",
        upc: p.upc ?? item?.itemId ?? "Unknown",
        size: item?.size ?? "Unknown",
        regular_price: item?.price?.regular ?? null,
        promo_price: item?.price?.promo ?? null,
      };
    });
  }

  // ── Cart operations ─────────────────────────────────────────────────────────

  /**
   * Add an item to the authenticated user's Kroger cart.
   * Equivalent to the Python `add_to_cart_tool`.
   */
  async addToCart(
    upc: string,
    quantity: number,
    modality: "PICKUP" | "DELIVERY"
  ): Promise<{ status: string; upc: string; quantity: number; modality: string }> {
    const putCart = (token: string) =>
      fetch(`${KROGER_API_BASE}/cart/add`, {
        method: "PUT",
        headers: {
          ...KROGER_DEFAULT_HEADERS,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [{ upc, quantity, modality }],
        }),
      });

    let response = await putCart(await this.getValidUserToken());

    // Kroger can reject an access token before our clock says it has expired
    // (e.g. it was revoked or replaced). Refresh once and retry before giving up.
    if (response.status === 401) {
      const stored = await this.getUserToken();
      if (stored?.refresh_token) {
        response = await putCart(await this.refreshUserToken(stored.refresh_token));
      }
    }

    if (!response.ok) {
      const body = await response.text();
      const hint = response.status === 401 ? ` ${REAUTH_HINT}` : "";
      throw new Error(`Kroger add-to-cart failed (${response.status}): ${body}${hint}`);
    }

    return { status: "success", upc, quantity, modality };
  }
}
