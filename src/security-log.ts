/**
 * security-log.ts — Structured security event logging.
 *
 * Every event is a single JSON line with `type: "security"`, so it can be
 * filtered in Cloudflare Workers Logs (dashboard → Workers → mcp-kroger → Logs)
 * or live with `wrangler tail --format json`.
 *
 * Query strings are never logged: they carry OAuth codes, state nonces, and
 * Kroger auth-link tokens.
 */

export type SecurityEvent =
  // Someone completed GitHub login but isn't ALLOWED_GITHUB_USERNAME
  | "github_login_denied"
  // The allowed user completed GitHub login and a new MCP grant was issued
  | "github_login_success"
  // /callback hit with missing/invalid/expired state (replay or forged request)
  | "github_callback_invalid"
  // /auth/kroger or its callback hit without a valid one-time link
  | "kroger_link_invalid"
  // OAuth endpoints or /mcp returned 4xx (bad/missing bearer token, bad grant, ...)
  | "oauth_rejected"
  // Request for a path this worker doesn't serve (scanners, probing)
  | "unknown_path";

type Severity = "info" | "warn";

const SEVERITY: Record<SecurityEvent, Severity> = {
  github_login_denied: "warn",
  github_login_success: "info",
  github_callback_invalid: "warn",
  kroger_link_invalid: "warn",
  oauth_rejected: "warn",
  unknown_path: "info",
};

export function logSecurityEvent(
  event: SecurityEvent,
  request: Request,
  details: Record<string, unknown> = {}
): void {
  const { pathname } = new URL(request.url);
  const cf = request.cf as IncomingRequestCfProperties | undefined;

  const entry = {
    type: "security",
    event,
    severity: SEVERITY[event],
    method: request.method,
    path: pathname,
    ip: request.headers.get("cf-connecting-ip"),
    country: cf?.country,
    asn: cf?.asn,
    asOrganization: cf?.asOrganization,
    userAgent: request.headers.get("user-agent"),
    ...details,
  };

  const line = JSON.stringify(entry);
  if (entry.severity === "warn") console.warn(line);
  else console.log(line);
}
