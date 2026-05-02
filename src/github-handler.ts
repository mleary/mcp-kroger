/**
 * github-handler.ts — GitHub OAuth handler for MCP server authentication
 *
 * This module handles the "who is allowed to use this MCP server?" question.
 *
 * The flow works like a nightclub bouncer:
 *   1. Claude.ai shows up and says "I want to use this MCP server"
 *   2. Our worker says "prove who you are — log in with GitHub"
 *   3. GitHub confirms your identity
 *   4. We check your GitHub username against ALLOWED_GITHUB_USERNAME
 *   5. If it matches, we issue a token that lets Claude.ai in
 *   6. Subsequent requests just show that token (no repeated logins)
 *
 * This integrates with @cloudflare/workers-oauth-provider which handles the
 * OAuth 2.0 Authorization Server protocol (the part Claude.ai talks to).
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import { createGithubAuthState, consumeGithubAuthState } from "./security";

// GitHub API/OAuth endpoints — these never change
const GITHUB_OAUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER = "https://api.github.com/user";

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Send the user to GitHub's login page
//
// Called when Claude.ai or a browser hits GET /authorize.
// We save the original OAuth request in a cookie so we can complete it
// after GitHub redirects back.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleAuthorize(
  request: Request,
  env: Env,
  oauthHelpers: OAuthHelpers
): Promise<Response> {
  // `parseAuthRequest` validates the incoming OAuth authorization request
  // (checks client_id, redirect_uri, etc.) — the library handles this for us.
  const authRequest = await oauthHelpers.parseAuthRequest(request);
  const stateId = await createGithubAuthState(env.OAUTH_KV, authRequest);

  // Build the GitHub authorization URL.
  // We ask for the "read:user" scope — enough to read the username.
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: new URL("/callback", new URL(request.url).origin).toString(),
    scope: "read:user",
    // Store the auth request server-side and send only a one-time nonce to GitHub.
    state: stateId,
  });

  return Response.redirect(`${GITHUB_OAUTH_URL}?${params}`, 302);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Handle GitHub's callback after the user logged in
//
// GitHub redirects to GET /callback?code=...&state=...
// We exchange the code for a token, verify the username, and complete
// the original OAuth authorization request.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleCallback(
  request: Request,
  env: Env,
  oauthHelpers: OAuthHelpers
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state parameter from GitHub", { status: 400 });
  }

  // ── Exchange GitHub code for a GitHub access token ────────────────────────
  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", url.origin).toString(),
    }),
  });

  if (!tokenResponse.ok) {
    return new Response("Failed to exchange GitHub code for token", { status: 502 });
  }

  const tokenData = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return new Response(`GitHub OAuth error: ${tokenData.error ?? "unknown"}`, { status: 400 });
  }

  // ── Fetch the GitHub user profile ─────────────────────────────────────────
  const userResponse = await fetch(GITHUB_API_USER, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "mcp-kroger-worker/1.0",
    },
  });

  if (!userResponse.ok) {
    return new Response("Failed to fetch GitHub user info", { status: 502 });
  }

  const user = (await userResponse.json()) as { login: string; id: number; name?: string };

  // ── Enforce the allowlist — only YOUR GitHub account gets in ──────────────
  if (user.login.toLowerCase() !== env.ALLOWED_GITHUB_USERNAME.toLowerCase()) {
    return new Response(
      `Access denied. GitHub user "${user.login}" is not authorized for this MCP server.`,
      { status: 403 }
    );
  }

  // ── Recover the original OAuth authorization request from state ───────────
  const authRequest = await consumeGithubAuthState<AuthRequest>(env.OAUTH_KV, state);
  if (!authRequest) {
    return new Response("Invalid or expired state parameter", { status: 400 });
  }

  // ── Complete the OAuth flow ───────────────────────────────────────────────
  // `completeAuthorization` mints an authorization code for the MCP client
  // (Claude.ai) and redirects back to it. The library handles token storage.
  //
  // `props` is arbitrary metadata we attach to this session — we store the
  // GitHub username so we can log who's making requests if needed.
  const { redirectTo } = await oauthHelpers.completeAuthorization({
    request: authRequest,
    userId: String(user.id),
    metadata: {
      githubLogin: user.login,
      displayName: user.name ?? user.login,
    },
    scope: authRequest.scope,
    // No extra claims needed for this personal server
    props: {
      githubLogin: user.login,
    },
  });

  return Response.redirect(redirectTo, 302);
}
