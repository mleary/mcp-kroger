# my-mcp-servers

Personal MCP server experiments, currently centered on a Kroger MCP server deployed
as a Cloudflare Worker.

The near-term goal is to keep each MCP provider cleanly isolated. The longer-term
goal is to add an MCP gateway that can expose a single authenticated MCP endpoint
while routing to provider-specific MCPs behind it.

## Current Server

### Kroger MCP

Cloudflare Worker MCP server for Kroger shopping workflows.

Available tools:

- `product_search_tool`: search Kroger products by query.
- `add_to_cart_tool`: add a product UPC to the authenticated Kroger cart.
- `reauthenticate_tool`: generate a private Kroger OAuth link when cart access expires.

See [SETUP.md](./SETUP.md) for deployment and Claude integration instructions.

## Current Layout

```text
.
├── src/
│   ├── index.ts              # Worker bootstrap and OAuth provider config
│   ├── routes.ts             # Non-MCP HTTP routes
│   ├── github-handler.ts     # GitHub OAuth for MCP access
│   ├── kroger-auth.ts        # Kroger browser OAuth flow
│   ├── kroger-client.ts      # Kroger API wrapper
│   ├── kroger-mcp-server.ts  # MCP tool registration
│   ├── security.ts           # Auth state and storage key helpers
│   └── types.ts              # Shared TypeScript types
├── SETUP.md
├── wrangler.toml.example
├── package.json
└── tsconfig.json
```

## Direction

The next server should not be added directly into the Kroger implementation.
Use one of these shapes instead:

```text
servers/
  kroger/
  next-provider/
gateway/
packages/
  auth/
  shared-types/
  config/
```

or keep the current single package briefly, but add provider modules under
`src/providers/<provider-name>/` and keep `src/index.ts` as bootstrap only.

For the gateway, start with an in-process tool aggregator if the servers share a
runtime and deployment target. Move to a reverse-proxy gateway later if providers
need independent runtimes, scaling, or deployments.

## Commands

```bash
npm install
npm run type-check
npm run dev
npm run deploy
```

## Notes

- `wrangler.toml` is intentionally ignored because it contains deployment-specific
  IDs and non-secret config.
- Secrets should be set with `wrangler secret put`, not committed.
- Kroger tokens are stored by provider and authenticated account so the storage
  model can survive multiple MCPs and a future gateway.
