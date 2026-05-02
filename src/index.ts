/**
 * index.ts — Main entry point for the Kroger MCP Cloudflare Worker
 *
 * This file wires three things together:
 *   1. KrogerMcpServer  — the MCP tools (product search, add to cart)
 *   2. OAuthProvider    — secures access via GitHub login (so only you can use it)
 *   3. Kroger OAuth     — /auth/kroger flow so the server can act on your cart
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  Claude.ai / iOS App                                │
 * │       │  (OAuth 2.0 — one-time GitHub login)        │
 * │       ▼                                             │
 * │  OAuthProvider (this file)                          │
 * │       │  (verified session token)                   │
 * │       ▼                                             │
 * │  KrogerMcpServer (MCP tools)                        │
 * │       │  (Kroger client credentials / user token)   │
 * │       ▼                                             │
 * │  Kroger API                                         │
 * └─────────────────────────────────────────────────────┘
 */

import OAuthProvider, { getOAuthApi, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KrogerClient } from "./kroger-client";
import { handleAuthorize, handleCallback } from "./github-handler";
import {
  createKrogerAuthLink,
  consumeKrogerAuthLink,
  escapeHtml,
  getPublicBaseUrl,
  hasKrogerAuthLink,
} from "./security";
import type { Env } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// KrogerMcpServer — the Durable Object that holds one MCP session
//
// Think of McpAgent like a Python class that also has a persistent "room" in
// Cloudflare's infrastructure. Each time Claude connects, a new room is created
// for that session. The room is destroyed when the session ends.
// ─────────────────────────────────────────────────────────────────────────────
export class KrogerMcpServer extends McpAgent<Env> {
  // `server` is the MCP protocol layer — it handles JSON-RPC messages
  server = new McpServer({
    name: "kroger-api",
    version: "1.0.0",
  });

  // `init()` is called once when the Durable Object is created.
  // This is where we register our tools — equivalent to Python's @mcp.tool() decorators.
  async init() {
    const kroger = new KrogerClient(this.env);

    // ── Tool 1: product_search_tool ────────────────────────────────────────
    // Searches the Kroger product catalogue. Uses client credentials (no user login needed).
    // z.string(), z.number(), etc. are Zod validators — they describe the shape
    // of the tool's inputs and auto-generate the JSON schema Claude sees.
    this.server.tool(
      "product_search_tool",
      "Search for products using the Kroger API based on user query. " +
        "Defaults to returning top 5 results. Results include description, brand, UPC, size, and price.",
      {
        query: z.string().describe("Search query (e.g. 'organic milk', 'chicken breast')"),
        limit: z
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe("Number of results to return (default 5, max 20)"),
      },
      async ({ query, limit }) => {
        try {
          const products = await kroger.searchProducts(query, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(products, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          };
        }
      }
    );

    // ── Tool 2: add_to_cart_tool ───────────────────────────────────────────
    // Adds an item to your Kroger cart. Requires a stored user OAuth token.
    // If the token is missing or expired, the error message tells Claude to
    // use reauthenticate_tool to get a new one.
    this.server.tool(
      "add_to_cart_tool",
      "Add an item to the authenticated user's Kroger cart. " +
        "Requires prior user authorization (cart.basic:write). " +
        "Use product_search_tool first to find a product UPC.",
      {
        upc: z.string().describe("Product UPC code from product_search_tool results"),
        quantity: z.number().min(1).default(1).describe("Quantity to add (default 1)"),
        modality: z
          .enum(["PICKUP", "DELIVERY"])
          .default("PICKUP")
          .describe("Fulfillment method — PICKUP or DELIVERY"),
        location_id: z
          .string()
          .optional()
          .describe("Store location ID (optional — uses server default if omitted)"),
      },
      async ({ upc, quantity, modality }) => {
        try {
          const result = await kroger.addToCart(upc, quantity, modality);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: String(err),
                  hint: "If this is an auth error, use reauthenticate_tool to get a Kroger authorization link.",
                }),
              },
            ],
          };
        }
      }
    );

    // ── Tool 3: reauthenticate_tool ────────────────────────────────────────
    // Returns a URL the user can click to re-authorize Kroger cart access.
    // Kroger user tokens expire in 30 minutes; this is the recovery path.
    this.server.tool(
      "reauthenticate_tool",
      "Get a Kroger authorization link when cart access has expired. " +
        "Click the returned URL in a browser to re-authorize, then retry add_to_cart_tool.",
      {},
      async () => {
        const authToken = await createKrogerAuthLink(this.env.OAUTH_KV);
        const publicBaseUrl = getPublicBaseUrl(this.env);
        const authUrl = new URL("/auth/kroger", publicBaseUrl);
        authUrl.searchParams.set("token", authToken);
        const isConfigured = !publicBaseUrl.includes("REPLACE_WITH_YOUR_ACCOUNT");

        return {
          content: [
            {
              type: "text",
              text: isConfigured
                ? `To re-authorize Kroger cart access, open this URL in your browser:\n\n` +
                  `  ${authUrl.toString()}\n\n` +
                  `After you approve access, return to Claude and retry add_to_cart_tool.`
                : `Set PUBLIC_BASE_URL in wrangler.toml to your deployed Worker URL, then open this path on that host:\n\n` +
                  `  /auth/kroger?token=${authToken}\n\n` +
                  `After you approve access, return to Claude and retry add_to_cart_tool.`,
            },
          ],
        };
      }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kroger OAuth flow — separate from the MCP server auth above.
// These routes let the Worker obtain a Kroger *user* token for cart access.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redirect the browser to Kroger's login page.
 * The callback URL must match what you registered in the Kroger Developer Portal.
 */
async function handleKrogerAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const authToken = url.searchParams.get("token");

  if (!authToken) {
    return htmlResponse(
      "Kroger cart authorization links are private. Use reauthenticate_tool in Claude to generate a fresh link.",
      403
    );
  }

  const isAuthorizedLink = await hasKrogerAuthLink(env.OAUTH_KV, authToken);
  if (!isAuthorizedLink) {
    return htmlResponse(
      "This Kroger authorization link is invalid or expired. Generate a new one from Claude.",
      403
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.KROGER_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/kroger/callback`,
    scope: "cart.basic:write profile.compact",
    state: authToken,
  });

  return Response.redirect(
    `https://api.kroger.com/v1/connect/oauth2/authorize?${params}`,
    302
  );
}

/**
 * Kroger redirects here after the user logs in.
 * We exchange the authorization code for a token and store it in KV.
 */
async function handleKrogerCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  if (error) {
    return htmlResponse(`❌ Kroger authorization was denied: ${error}`, 400);
  }
  if (!state) {
    return htmlResponse("❌ Missing Kroger authorization state.", 400);
  }
  const isValidState = await consumeKrogerAuthLink(env.OAUTH_KV, state);
  if (!isValidState) {
    return htmlResponse("❌ Invalid or expired Kroger authorization state.", 400);
  }
  if (!code) {
    return htmlResponse("❌ No authorization code received from Kroger.", 400);
  }

  // Exchange authorization code for access + refresh tokens
  const credentials = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
  const tokenResponse = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${new URL(request.url).origin}/auth/kroger/callback`,
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    return htmlResponse(`❌ Kroger token exchange failed: ${body}`, 502);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenData = (await tokenResponse.json()) as any;

  // Store in KV — TOKEN_STORE persists across requests
  await env.TOKEN_STORE.put(
    "kroger_user_token",
    JSON.stringify({ ...tokenData, stored_at: Date.now() }),
    {
      // Keep in KV for 24 hours; we'll refresh it automatically before it expires
      expirationTtl: 86400,
    }
  );

  const expiryMinutes = Math.round((tokenData.expires_in ?? 1800) / 60);
  return htmlResponse(
    `✅ Kroger authorization successful!\n` +
      `Token expires in ${expiryMinutes} minutes (auto-refreshes if you have a refresh token).\n\n` +
      `You can close this window and return to Claude.`,
    200
  );
}

/** Small helper to return a styled HTML page for the auth routes. */
function htmlResponse(message: string, status: number): Response {
  const isError = status >= 400;
  const icon = isError ? "❌" : "✅";
  const escapedMessage = escapeHtml(message);
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${icon} Kroger MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto;
           padding: 0 20px; color: #333; }
    pre  { background: #f5f5f5; padding: 16px; border-radius: 8px;
           white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h2>Kroger MCP Server</h2>
  <pre>${escapedMessage}</pre>
</body>
</html>`,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Content-Type": "text/html;charset=UTF-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// "Default handler" — handles all routes that aren't the /mcp endpoint.
//
// In workers-oauth-provider >=0.0.5, defaultHandler is a plain ExportedHandler.
// OAuthHelpers is obtained via getOAuthApi(providerOptions, env) rather than
// being injected as a 4th argument.
// ─────────────────────────────────────────────────────────────────────────────

// Forward-declared so defaultHandler's closure can reference it at call time.
let providerOptions: OAuthProviderOptions<Env>;

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const oauthHelpers: OAuthHelpers = getOAuthApi(providerOptions, env);
    const { pathname } = new URL(request.url);

    // GitHub OAuth routes (for authenticating Claude to this MCP server)
    if (pathname === "/authorize") return handleAuthorize(request, env, oauthHelpers);
    if (pathname === "/callback") return handleCallback(request, env, oauthHelpers);

    // Kroger OAuth routes (for authorizing this server to access your Kroger cart)
    if (pathname === "/auth/kroger") return handleKrogerAuthStart(request, env);
    if (pathname === "/auth/kroger/callback") return handleKrogerCallback(request, env);

    // Landing page
    return htmlResponse(
      "Kroger MCP Server — private.\n\n" +
        "• Connect via Claude.ai Integrations settings.\n" +
        "• To authorize Kroger cart access: use reauthenticate_tool in Claude.",
      200
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main export — OAuthProvider wraps everything.
//
// OAuthProvider is like a security vestibule: Claude.ai must authenticate
// (via GitHub) before it can reach the /mcp endpoint. Unauthenticated requests
// are redirected to /authorize.
// ─────────────────────────────────────────────────────────────────────────────
providerOptions = {
  // The path Claude.ai connects to for MCP calls
  apiRoute: "/mcp",

  // The MCP server handler — only reachable after OAuth
  apiHandler: KrogerMcpServer.serve("/mcp"),

  // Handles /authorize, /callback, /auth/kroger, and the landing page
  defaultHandler,

  // Standard OAuth 2.0 endpoints (the library implements these for us)
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register", // Required for Claude.ai's Dynamic Client Registration
  allowPlainPKCE: false,

};

export default new OAuthProvider(providerOptions);
