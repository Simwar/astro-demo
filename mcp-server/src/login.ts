/**
 * The login + consent screen. This is what `authorize()` renders instead of
 * auto-approving: the user signs in, and only then does the server issue an
 * authorization code bound to their identity.
 *
 * Flow: GET /authorize (handled by mcpAuthRouter) -> provider.authorize()
 * renders this form -> POST /login validates credentials -> redirect back to
 * the client's redirect_uri with the code.
 */
import type { Express, Request, Response } from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { InMemoryOAuthProvider } from "./oauth-provider";
import { authenticate, DEMO_USERS } from "./users";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export interface LoginPageData {
  clientId: string;
  clientName?: string;
  params: AuthorizationParams;
  error?: string;
}

export function renderLoginPage({ clientId, clientName, params, error }: LoginPageData): string {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const app = escapeHtml(clientName || clientId);
  const demo = DEMO_USERS.map((u) => `${u.username} / ${u.password}`).join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b1020; color: #e6eaf2; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { background: #131a2e; border: 1px solid #243049; border-radius: 12px; padding: 28px; width: 320px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    p.sub { color: #9aa6c0; font-size: 13px; margin: 0 0 20px; }
    label { display: block; font-size: 13px; margin: 14px 0 6px; color: #c3cbe0; }
    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #2c3a5a; background: #0e1424; color: #fff; }
    button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px; background: #3e3bc9; color: #fff; font-weight: 600; cursor: pointer; }
    .err { background: #3a1620; border: 1px solid #6b2230; color: #ffb3c0; padding: 9px 11px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
    .hint { margin-top: 18px; font-size: 12px; color: #7e8aa6; text-align: center; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>Sign in</h1>
    <p class="sub"><strong>${app}</strong> wants to access your notes.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    ${hidden("client_id", clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("state", params.state)}
    ${hidden("scope", params.scopes?.join(" "))}
    ${hidden("resource", params.resource?.href)}
    <button type="submit">Sign in &amp; authorize</button>
    <div class="hint">Demo accounts: ${escapeHtml(demo)}</div>
  </form>
</body>
</html>`;
}

export function mountLogin(app: Express, provider: InMemoryOAuthProvider): void {
  app.post("/login", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const clientId = String(body.client_id ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    const codeChallenge = String(body.code_challenge ?? "");
    const scopes = body.scope ? String(body.scope).split(" ").filter(Boolean) : [];
    const resource = body.resource ? String(body.resource) : undefined;
    const state = body.state ? String(body.state) : undefined;

    const client = await provider.clientsStore.getClient(clientId);
    if (!client) {
      res.status(400).send("Unknown client.");
      return;
    }
    // Re-validate the redirect_uri against the registered client (defense in depth).
    if (!client.redirect_uris.includes(redirectUri)) {
      res.status(400).send("Invalid redirect_uri for this client.");
      return;
    }

    const user = authenticate(String(body.username ?? ""), String(body.password ?? ""));
    if (!user) {
      res.status(401).send(
        renderLoginPage({
          clientId,
          clientName: client.client_name,
          error: "Invalid username or password.",
          params: {
            codeChallenge,
            redirectUri,
            state,
            scopes,
            resource: resource ? new URL(resource) : undefined,
          },
        }),
      );
      return;
    }

    const code = provider.issueCode(clientId, user.id, { codeChallenge, redirectUri, scopes, resource });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.redirect(target.toString());
  });
}
