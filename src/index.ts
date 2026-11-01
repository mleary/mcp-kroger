import OAuthProvider, { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { KrogerMcpServer } from "./kroger-mcp-server";
import { createDefaultHandler } from "./routes";
import { logSecurityEvent } from "./security-log";
import type { Env } from "./types";

export { KrogerMcpServer };

let providerOptions: OAuthProviderOptions<Env>;

const defaultHandler = createDefaultHandler((env) =>
  getOAuthApi(providerOptions, env)
);

providerOptions = {
  apiRoute: "/mcp",
  apiHandler: KrogerMcpServer.serve("/mcp"),
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  allowPlainPKCE: false,
};

const oauthProvider = new OAuthProvider(providerOptions);

// Paths answered by the OAuth library itself (our own routes log their own events).
function isLibraryPath(pathname: string): boolean {
  return pathname.startsWith("/mcp") || pathname === "/token" || pathname === "/register";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await oauthProvider.fetch(request, env, ctx);

    const { pathname } = new URL(request.url);
    if (response.status >= 400 && response.status < 500 && isLibraryPath(pathname)) {
      // A 401 without a bearer token is normal once per connect (client discovering
      // auth). A 401 *with* one means an expired, revoked, or forged token.
      logSecurityEvent("oauth_rejected", request, {
        status: response.status,
        hadBearerToken: request.headers.get("authorization")?.startsWith("Bearer ") ?? false,
      });
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
