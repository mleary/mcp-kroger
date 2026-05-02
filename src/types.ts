/**
 * types.ts — Shared TypeScript types for the Kroger MCP Worker.
 *
 * In TypeScript, an `interface` is like a blueprint that describes the
 * *shape* of an object — what properties it has and what types they are.
 * This `Env` interface tells TypeScript what to expect on the `env` object
 * that Cloudflare passes into every Worker request handler.
 */

export interface Env {
  // ── Durable Object namespace ──────────────────────────────────────────────
  // Cloudflare uses this to spin up a KrogerMcpServer Durable Object instance
  // per MCP session. Think of it as a session factory.
  MCP_OBJECT: DurableObjectNamespace;

  // ── KV Namespaces (key-value stores) ─────────────────────────────────────
  // TOKEN_STORE: where we persist your Kroger OAuth user token between requests.
  //   Key: "kroger_user_token"   Value: JSON string of the token object
  TOKEN_STORE: KVNamespace;

  // OAUTH_KV: used internally by @cloudflare/workers-oauth-provider to track
  //   in-flight OAuth sessions (like a temporary clipboard for auth state).
  OAUTH_KV: KVNamespace;

  // ── Kroger API credentials (set via `wrangler secret put`) ───────────────
  KROGER_CLIENT_ID: string;
  KROGER_CLIENT_SECRET: string;
  KROGER_STORE_ID: string; // e.g. "70100286" — find yours at Kroger's store locator

  // ── GitHub OAuth app credentials (for authenticating YOU to this MCP server)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERNAME: string; // e.g. "mattleary" — only this GitHub user gets access

  // ── Cookie secret — random 32-byte hex string used to sign session cookies
  COOKIE_SECRET: string;
  PUBLIC_BASE_URL?: string; // e.g. "https://mcp-kroger.<account>.workers.dev"
}

// ── Kroger API response shapes ────────────────────────────────────────────────
// These describe what the Kroger API sends back. We only pick out the fields
// we actually use; extras are safely ignored.

export interface KrogerTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string; // only present for user OAuth (not client credentials)
  scope?: string;
}

export interface KrogerProduct {
  productId: string;
  upc?: string;
  brand?: string;
  description?: string;
  temperature?: { indicator: string };
  items?: Array<{
    itemId?: string;
    size?: string;
    price?: {
      regular?: number;
      promo?: number;
    };
  }>;
  categories?: string[];
}

export interface KrogerProductSearchResponse {
  data?: KrogerProduct[];
  meta?: {
    pagination?: {
      total: number;
      limit: number;
      offset: number;
    };
  };
}

// What we store in KV for the user token (extends the Kroger response with metadata)
export interface StoredKrogerToken extends KrogerTokenResponse {
  stored_at: number; // Unix timestamp (ms) so we can check if it's about to expire
}

// The clean product shape we return from our MCP tool (no clutter)
export interface CleanProduct {
  description: string;
  brand: string;
  upc: string;
  size: string;
  regular_price: number | null;
  promo_price: number | null;
}
