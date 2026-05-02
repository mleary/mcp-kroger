import { escapeHtml } from "./security";

export function htmlResponse(message: string, status: number): Response {
  const escapedMessage = escapeHtml(message);

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kroger MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto;
           padding: 0 20px; color: #333; }
    pre  { background: #f5f5f5; padding: 16px; border-radius: 8px;
           white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h2>Kroger MCP Server</h2>
  <pre>${escapedMessage}</pre>
</body>
</html>`,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Content-Type": "text/html;charset=UTF-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}
