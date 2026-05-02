import { htmlResponse } from "./html-response";
import {
  consumeKrogerAuthLink,
  hasKrogerAuthLink,
  krogerUserTokenKey,
} from "./security";
import type { Env, KrogerTokenResponse, StoredKrogerToken } from "./types";

const KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";

/**
 * Redirect the browser to Kroger's login page.
 * The callback URL must match what you registered in the Kroger Developer Portal.
 */
export async function handleKrogerAuthStart(
  request: Request,
  env: Env
): Promise<Response> {
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
 * We exchange the authorization code for a token and store it by MCP account.
 */
export async function handleKrogerCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  if (error) {
    return htmlResponse(`Kroger authorization was denied: ${error}`, 400);
  }
  if (!state) {
    return htmlResponse("Missing Kroger authorization state.", 400);
  }

  const authLinkState = await consumeKrogerAuthLink(env.OAUTH_KV, state);
  if (!authLinkState) {
    return htmlResponse("Invalid or expired Kroger authorization state.", 400);
  }
  if (!code) {
    return htmlResponse("No authorization code received from Kroger.", 400);
  }

  const credentials = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
  const tokenResponse = await fetch(KROGER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/kroger/callback`,
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    return htmlResponse(`Kroger token exchange failed: ${body}`, 502);
  }

  const tokenData = (await tokenResponse.json()) as KrogerTokenResponse;
  const storedToken: StoredKrogerToken = { ...tokenData, stored_at: Date.now() };

  await env.TOKEN_STORE.put(
    krogerUserTokenKey(authLinkState.accountId),
    JSON.stringify(storedToken),
    { expirationTtl: 86400 }
  );

  const expiryMinutes = Math.round((tokenData.expires_in ?? 1800) / 60);
  return htmlResponse(
    `Kroger authorization successful.\n` +
      `Token expires in ${expiryMinutes} minutes and will auto-refresh if Kroger returned a refresh token.\n\n` +
      `You can close this window and return to Claude.`,
    200
  );
}
