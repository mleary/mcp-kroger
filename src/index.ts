import OAuthProvider, { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { KrogerMcpServer } from "./kroger-mcp-server";
import { createDefaultHandler } from "./routes";
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

export default new OAuthProvider(providerOptions);
