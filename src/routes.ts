import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize, handleCallback } from "./github-handler";
import { htmlResponse } from "./html-response";
import { handleKrogerAuthStart, handleKrogerCallback } from "./kroger-auth";
import type { Env } from "./types";

type OAuthHelpersResolver = (env: Env) => OAuthHelpers;

export function createDefaultHandler(resolveOAuthHelpers: OAuthHelpersResolver) {
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      const oauthHelpers = resolveOAuthHelpers(env);
      const { pathname } = new URL(request.url);

      if (pathname === "/authorize") return handleAuthorize(request, env, oauthHelpers);
      if (pathname === "/callback") return handleCallback(request, env, oauthHelpers);

      if (pathname === "/auth/kroger") return handleKrogerAuthStart(request, env);
      if (pathname === "/auth/kroger/callback") {
        return handleKrogerCallback(request, env);
      }

      return htmlResponse(
        "Kroger MCP Server - private.\n\n" +
          "- Connect via Claude.ai Integrations settings.\n" +
          "- To authorize Kroger cart access: use reauthenticate_tool in Claude.",
        200
      );
    },
  };
}
