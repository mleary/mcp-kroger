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

const KROGER_API_BASE = "https://api.kroger.com/v1";
const KROGER_TOKEN_URL = `${KROGER_API_BASE}/connect/oauth2/token`;

// ─────────────────────────────────────────────────────────────────────────────
// KrogerClient class
//
// In TypeScript, a `class` bundles related data (properties) and behaviour
// (methods) together — same concept as Python classes.
// ─────────────────────────────────────────────────────────────────────────────
export class KrogerClient {
  private env: Env;

  // `constructor` runs once when you do `new KrogerClient(env)`.
  // The `private` keyword means `this.env` can only be used inside this class.
  constructor(env: Env) {
    this.env = env;
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
    const raw = await this.env.TOKEN_STORE.get("kroger_user_token");
    if (!raw) return null;
    return JSON.parse(raw) as StoredKrogerToken;
  }

  /**
   * Try to refresh the user token using the refresh_token grant.
   * Kroger user tokens expire in 30 minutes; refresh tokens last much longer.
   * Returns the new access token, or throws if refresh fails.
   */
  async refreshUserToken(refreshToken: string): Promise<string> {
    const response = await fetch(KROGER_TOKEN_URL, {
      method: "POST",
      headers: {
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
      throw new Error(`Kroger token refresh failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as KrogerTokenResponse;

    // Persist the refreshed token back to KV
    const updated: StoredKrogerToken = { ...data, stored_at: Date.now() };
    await this.env.TOKEN_STORE.put(
      "kroger_user_token",
      JSON.stringify(updated),
      { expirationTtl: 86400 } // keep in KV for 24h; Kroger will reject it earlier
    );

    return data.access_token;
  }

  /**
   * Get a valid user access token, auto-refreshing if needed.
   * Think of this like a smart key-holder that renews the key before it expires.
   */
  async getValidUserToken(): Promise<string> {
    const stored = await this.getUserToken();
    if (!stored) {
      throw new Error(
        "No Kroger user token found. " +
          "Visit /auth/kroger in a browser to authorize cart access."
      );
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
        "Kroger user token has expired and no refresh token is available. " +
          "Visit /auth/kroger to re-authorize."
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
      headers: { Authorization: `Bearer ${token}` },
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
    const token = await this.getValidUserToken();

    const response = await fetch(`${KROGER_API_BASE}/cart/add`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ upc, quantity, modality }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kroger add-to-cart failed (${response.status}): ${body}`);
    }

    return { status: "success", upc, quantity, modality };
  }
}
