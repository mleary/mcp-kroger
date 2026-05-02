# Kroger MCP Server — Cloudflare Workers Setup Guide

This guide walks you through deploying `mcp-kroger-cloudflare` to Cloudflare Workers so it's reachable from Claude.ai (web) and the Claude iOS app.

---

## How it works (the big picture)

```
Claude.ai / iOS App
    │
    │  ← Step A: Claude authenticates to YOUR server via GitHub login (once)
    ▼
Cloudflare Worker  (your MCP server, running 24/7 for free)
    │
    │  ← Step B: Worker authenticates to Kroger's API using your credentials
    ▼
Kroger API
```

Two separate auth layers, one for each hop. This guide sets them both up.

---

## Prerequisites

- **Node.js 18+** — check with `node --version`; install at https://nodejs.org if needed
- **A GitHub account** — used to protect access to your MCP server
- **Your Kroger developer credentials** — you already have these (`client_id`, `client_secret`)

---

## Phase 1: Cloudflare Account Setup (~10 min)

### 1.1 Create a free Cloudflare account

Go to https://dash.cloudflare.com/sign-up and sign up. The free tier is more than enough.

### 1.2 Install the Wrangler CLI

Wrangler is Cloudflare's command-line tool — like `aws` CLI but for Cloudflare.

```bash
npm install -g wrangler
```

### 1.3 Log in

```bash
wrangler login
```

This opens a browser window. Authorize the CLI with your Cloudflare account.

### 1.4 Create the two KV namespaces

KV ("Key-Value") is Cloudflare's persistent storage — like a tiny cloud database.
We need two: one for your Kroger token, one for OAuth session state.

```bash
# From the mcp-kroger-cloudflare directory:
wrangler kv namespace create TOKEN_STORE
wrangler kv namespace create OAUTH_KV
```

Each command prints something like:
```
{ binding = "TOKEN_STORE", id = "abc123def456..." }
```

**Copy those IDs** and paste them into `wrangler.toml` where it says `REPLACE_WITH_..._KV_ID`.

---

## Phase 2: GitHub OAuth App (~5 min)

This is what lets you log in with GitHub to authorize Claude's access to your MCP server.

### 2.1 Create a GitHub OAuth App

1. Go to https://github.com/settings/developers
2. Click **"New OAuth App"**
3. Fill in:
   - **Application name**: `Kroger MCP Server` (anything works)
   - **Homepage URL**: `https://mcp-kroger.YOUR_CF_ACCOUNT.workers.dev`
     *(You'll fill in your real subdomain after the first deploy — use a placeholder for now)*
   - **Authorization callback URL**: `https://mcp-kroger.YOUR_CF_ACCOUNT.workers.dev/callback`
     *(Same note — update this after first deploy)*
4. Click **Register application**
5. On the next page, copy your **Client ID**
6. Click **Generate a new client secret** and copy the **Client Secret**

> **What's your workers.dev subdomain?**
> Run `wrangler whoami` — your account name/ID is shown. Your Worker URL will be
> `https://mcp-kroger.<account-subdomain>.workers.dev`
> You can also just deploy first (Phase 4) and then come back to update the callback URL.

### 2.2 Update wrangler.toml

Open `wrangler.toml` and set:
```toml
ALLOWED_GITHUB_USERNAME = "your-actual-github-username"
PUBLIC_BASE_URL = "https://mcp-kroger.YOUR_CF_ACCOUNT.workers.dev"
```

---

## Phase 3: Kroger Developer App — Add Callback URL (~2 min)

Your existing Kroger developer app needs one new redirect URI for this cloud deployment.

1. Go to https://developer.kroger.com/my-applications
2. Edit your application
3. Add this redirect URI: `https://mcp-kroger.YOUR_CF_ACCOUNT.workers.dev/auth/kroger/callback`
4. Save

---

## Phase 4: Store Secrets (~5 min)

Secrets are encrypted values stored in Cloudflare — they never appear in your code or git history.

```bash
# From the mcp-kroger-cloudflare directory:

# Your Kroger developer credentials
wrangler secret put KROGER_CLIENT_ID
# (paste your Kroger client_id when prompted, then Enter)

wrangler secret put KROGER_CLIENT_SECRET
# (paste your Kroger client_secret when prompted)

# GitHub OAuth App credentials (from Phase 2)
wrangler secret put GITHUB_CLIENT_ID
# (paste your GitHub OAuth App client ID)

wrangler secret put GITHUB_CLIENT_SECRET
# (paste your GitHub OAuth App client secret)

# Random 64-character hex string — used to sign session cookies
# Generate one with:  openssl rand -hex 32
wrangler secret put COOKIE_SECRET
# (paste the generated string)
```

---

## Phase 5: Install Dependencies & Deploy (~3 min)

```bash
# From the mcp-kroger-cloudflare directory:

# Install Node packages
npm install

# Check TypeScript for errors (optional but useful)
npm run type-check

# Deploy to Cloudflare
npm run deploy
```

The deploy output will include your Worker URL:
```
Published mcp-kroger (X.XXs)
  https://mcp-kroger.YOUR_ACCOUNT.workers.dev
```

**Now go back and update:**
1. The GitHub OAuth App callback URL (Phase 2.1)
2. The Kroger Developer Portal callback URL (Phase 3)

Both should use your real `workers.dev` URL.

---

## Phase 6: Connect to Claude.ai (~3 min)

You should connect the integration before cart authorization so you can use the
private `reauthenticate_tool` to generate a one-time Kroger auth link.

### Claude.ai (web)

1. Go to https://claude.ai and open **Settings** (bottom-left)
2. Click **Integrations** → **Add custom integration** (or similar — UI may vary)
3. Enter your Worker URL: `https://mcp-kroger.YOUR_ACCOUNT.workers.dev/mcp`
4. Claude will redirect you through the OAuth flow → log in with GitHub
5. ✅ Done — you'll see `kroger-api` tools available in Claude

### Claude iOS App

Same process — go to Settings → Integrations and add the same URL.
The OAuth flow will open in Safari.

---

## Phase 7: Authorize Kroger Cart Access (~2 min)

Your Worker can search Kroger products immediately (that uses client credentials).
For cart access, you need to do a one-time authorization using a private link:

1. In Claude, run `reauthenticate_tool`
2. Open the one-time URL it returns in your browser
3. Log in with your Kroger account and approve the permissions
4. You'll see a success page — the token is now stored in your KV store

The Worker will automatically refresh this token before it expires. If it ever expires
without a refresh token, you'll re-visit this URL (or use `reauthenticate_tool` in Claude).

---

## Testing

Once connected, try these in Claude:

```
Search for almond milk at Kroger
→ Uses product_search_tool

Add 2 cartons of the Silk Oat Milk (UPC from search results) to my cart for pickup
→ Uses add_to_cart_tool
```

---

## Local Development

Test locally before deploying:

```bash
wrangler dev
```

This runs your Worker at `http://localhost:8787`. MCP clients can connect to
`http://localhost:8787/mcp`. Note: OAuth flows won't work locally without a tunnel
(like `cloudflared tunnel`), but you can test the Kroger API routes directly.

---

## Updating the Worker

After any code changes:

```bash
npm run deploy
```

That's it — Cloudflare deploys in ~3 seconds with zero downtime.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `wrangler deploy` fails with "missing binding" | Check that your KV IDs are set in `wrangler.toml` |
| GitHub callback gives "bad state" error | Make sure the callback URL in GitHub matches exactly |
| Cart returns auth error | Run `reauthenticate_tool` in Claude and open the returned link |
| "Access denied" on GitHub login | Check `ALLOWED_GITHUB_USERNAME` in `wrangler.toml` |
| Claude can't find the server | Make sure you used `/mcp` at the end of the URL |
| TypeScript errors on `npm run type-check` | Run `npm run cf-typegen` first to regenerate types |

---

## Security Notes

- **Your Worker URL is public** — but the OAuth layer means only your GitHub account can trigger MCP calls
- **Kroger credentials** are stored as Cloudflare Secrets (encrypted at rest, never in logs)
- **Your Kroger user token** is stored in KV (encrypted at rest by Cloudflare)
- **The Kroger cart authorization link** is private and one-time use — generate it via `reauthenticate_tool`
- **Do not commit secrets** to git — they live in Cloudflare only

---

## File Reference

```
mcp-kroger-cloudflare/
├── src/
│   ├── index.ts           Main Worker: MCP tools + OAuth provider + Kroger auth routes
│   ├── kroger-client.ts   Kroger API wrapper (product search, cart, token management)
│   ├── github-handler.ts  GitHub OAuth handler (who can use this MCP server)
│   └── types.ts           TypeScript interfaces (Env, API response shapes)
├── wrangler.toml          Cloudflare Worker config (bindings, vars) — edit this
├── package.json           Node dependencies
├── tsconfig.json          TypeScript compiler settings
└── SETUP.md               This file
```
