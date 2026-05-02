import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KrogerClient } from "./kroger-client";
import {
  createKrogerAuthLink,
  getPublicBaseUrl,
  resolveAuthenticatedAccountId,
} from "./security";
import type { AuthenticatedUserProps, Env } from "./types";

export class KrogerMcpServer extends McpAgent<Env, unknown, AuthenticatedUserProps> {
  server = new McpServer({
    name: "kroger-api",
    version: "1.0.0",
  });

  async init() {
    const createKrogerClient = () =>
      new KrogerClient(
        this.env,
        resolveAuthenticatedAccountId(this.env, this.props)
      );

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
          const products = await createKrogerClient().searchProducts(query, limit);
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
          .describe("Fulfillment method: PICKUP or DELIVERY"),
      },
      async ({ upc, quantity, modality }) => {
        try {
          const result = await createKrogerClient().addToCart(
            upc,
            quantity,
            modality
          );
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

    this.server.tool(
      "reauthenticate_tool",
      "Get a Kroger authorization link when cart access has expired. " +
        "Click the returned URL in a browser to re-authorize, then retry add_to_cart_tool.",
      {},
      async () => {
        const accountId = resolveAuthenticatedAccountId(this.env, this.props);
        const authToken = await createKrogerAuthLink(this.env.OAUTH_KV, accountId);
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
