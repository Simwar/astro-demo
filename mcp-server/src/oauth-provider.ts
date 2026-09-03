/**
 * In-memory OAuth 2.1 server provider for the MCP server.
 *
 * Implements the MCP SDK's OAuthServerProvider so `mcpAuthRouter` can expose a
 * full authorization server: dynamic client registration (RFC 7591), the
 * authorization-code flow with PKCE, and refresh tokens. State is in-memory, so
 * it resets on restart — fine for a demo; back it with a store (e.g. Redis) for
 * anything real.
 *
 * `authorize()` renders a login screen (see login.ts) rather than auto-
 * approving. The signed-in user's id is bound to the authorization code and the
 * tokens issued from it, and surfaced to tools via AuthInfo.extra.userId — so
 * every tool call is scoped to the caller.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { renderLoginPage } from "./login";

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const SCOPES_SUPPORTED = ["mcp:read", "mcp:write"];

const now = () => Math.floor(Date.now() / 1000);
const newToken = () => randomBytes(32).toString("base64url");

interface CodeRecord {
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface RefreshRecord {
  clientId: string;
  userId: string;
  scopes: string[];
  resource?: string;
}

export class InMemoryOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly accessTokens = new Map<string, AuthInfo>();
  private readonly refreshTokens = new Map<string, RefreshRecord>();

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => this.clients.get(clientId),
    registerClient: (client) => {
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: now(),
      };
      this.clients.set(full.client_id, full);
      return full;
    },
  };

  /**
   * Render the login screen. The form POSTs to /login (see mountLogin), which
   * authenticates the user and calls issueCode() to complete the flow.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    res.send(renderLoginPage({ clientId: client.client_id, clientName: client.client_name, params }));
  }

  /** Issue an authorization code for an authenticated user. Called by /login. */
  issueCode(
    clientId: string,
    userId: string,
    opts: { codeChallenge: string; redirectUri: string; scopes: string[]; resource?: string },
  ): string {
    const code = newToken();
    this.codes.set(code, {
      clientId,
      userId,
      codeChallenge: opts.codeChallenge,
      redirectUri: opts.redirectUri,
      scopes: opts.scopes,
      resource: opts.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    return code;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE verified by the router against challengeForAuthorizationCode
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    this.codes.delete(authorizationCode);
    if (record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code expired");
    }
    return this.issueTokens(client.client_id, record.userId, record.scopes, resource?.href ?? record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    this.refreshTokens.delete(refreshToken); // rotate
    const grantedScopes = scopes?.length ? scopes : record.scopes;
    return this.issueTokens(client.client_id, record.userId, grantedScopes, resource?.href ?? record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.accessTokens.get(token);
    if (!info || (info.expiresAt !== undefined && info.expiresAt < now())) {
      throw new InvalidTokenError("Token is invalid or expired");
    }
    return info;
  }

  private issueTokens(
    clientId: string,
    userId: string,
    scopes: string[],
    resource?: string,
  ): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    this.accessTokens.set(accessToken, {
      token: accessToken,
      clientId,
      scopes,
      expiresAt: now() + ACCESS_TTL_SECONDS,
      resource: resource ? new URL(resource) : undefined,
      extra: { userId }, // surfaced to tools as extra.authInfo.extra.userId
    });
    this.refreshTokens.set(refreshToken, { clientId, userId, scopes, resource });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
