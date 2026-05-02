import type { AuthenticatedUserProps, Env, KrogerAuthLinkState } from "./types";

const AUTH_STATE_TTL_SECONDS = 600;

const GITHUB_AUTH_PREFIX = "auth:github:";
const KROGER_AUTH_PREFIX = "auth:kroger:";
export const LEGACY_KROGER_USER_TOKEN_KEY = "kroger_user_token";

function namespacedKey(prefix: string, token: string): string {
  return `${prefix}${token}`;
}

async function putJson(
  kv: KVNamespace,
  key: string,
  value: unknown,
  expirationTtl: number = AUTH_STATE_TTL_SECONDS
): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}

async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;

  return JSON.parse(raw) as T;
}

export async function createGithubAuthState(kv: KVNamespace, authRequest: unknown): Promise<string> {
  const stateId = crypto.randomUUID();
  await putJson(kv, namespacedKey(GITHUB_AUTH_PREFIX, stateId), authRequest);
  return stateId;
}

export async function consumeGithubAuthState<T>(
  kv: KVNamespace,
  stateId: string
): Promise<T | null> {
  const key = namespacedKey(GITHUB_AUTH_PREFIX, stateId);
  const authRequest = await getJson<T>(kv, key);

  if (!authRequest) return null;

  await kv.delete(key);
  return authRequest;
}

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

export function resolveAuthenticatedAccountId(
  env: Pick<Env, "ALLOWED_GITHUB_USERNAME">,
  props?: Partial<AuthenticatedUserProps>
): string {
  const githubLogin = props?.githubLogin?.trim();
  return githubLogin || env.ALLOWED_GITHUB_USERNAME;
}

export function krogerUserTokenKey(accountId: string): string {
  return `tokens:kroger:${normalizeStorageSegment(accountId)}`;
}

export async function createKrogerAuthLink(
  kv: KVNamespace,
  accountId: string
): Promise<string> {
  const stateId = crypto.randomUUID();
  const state: KrogerAuthLinkState = { issuedAt: Date.now(), accountId };
  await putJson(kv, namespacedKey(KROGER_AUTH_PREFIX, stateId), state);
  return stateId;
}

export async function hasKrogerAuthLink(kv: KVNamespace, stateId: string): Promise<boolean> {
  const state = await kv.get(namespacedKey(KROGER_AUTH_PREFIX, stateId));
  return state !== null;
}

export async function consumeKrogerAuthLink(
  kv: KVNamespace,
  stateId: string
): Promise<KrogerAuthLinkState | null> {
  const key = namespacedKey(KROGER_AUTH_PREFIX, stateId);
  const state = await getJson<KrogerAuthLinkState>(kv, key);

  if (!state) return null;

  await kv.delete(key);
  return state;
}

export function getPublicBaseUrl(env: { PUBLIC_BASE_URL?: string }): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return "https://mcp-kroger.REPLACE_WITH_YOUR_ACCOUNT.workers.dev";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
