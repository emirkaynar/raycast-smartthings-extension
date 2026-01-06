export interface Env {
  AUTH_KV: KVNamespace;

  ST_CLIENT_ID: string;
  ST_CLIENT_SECRET: string;

  /** Optional; default uses PUBLIC_BASE_URL + '/v1/callback' */
  ST_REDIRECT_URI?: string;

  /** Optional; default is SmartThings global token URL */
  ST_TOKEN_URL?: string;

  /** Optional; default is SmartThings global authorize URL (may need adjustment per your app registration). */
  ST_AUTHORIZATION_URL?: string;

  /** Optional; space-delimited scopes. */
  ST_SCOPES?: string;

  /** Required if ST_REDIRECT_URI is not set. Example: https://xxx.workers.dev */
  PUBLIC_BASE_URL?: string;

  /** Base64-encoded 32-byte key for AES-GCM encryption of tokens */
  TOKEN_ENC_KEY_B64: string;
}

type PairRecord = {
  status: "pending" | "completed" | "error";
  createdAt: string;
  sessionToken?: string;
  error?: string;
};

type TokenRecord = {
  updatedAt: string;
  accessTokenEnc: string;
  accessTokenExpiresAt: string; // ISO
  refreshTokenEnc: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function withCors(req: Request, resp: Response): Response {
  const headers = new Headers(resp.headers);

  // Raycast extensions run outside the browser, so CORS isn't required for normal usage,
  // but it makes local/manual testing easier and doesn't rely on cookies.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-max-age", "86400");

  // Avoid caching token responses in intermediaries.
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init?.headers || {}),
    },
  });
}

function badRequest(message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...(extra || {}) }, { status: 400 });
}

function unauthorized(message = "Unauthorized"): Response {
  return json({ error: message }, { status: 401 });
}

function notFound(): Response {
  return json({ error: "Not Found" }, { status: 404 });
}

function randomBase64Url(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  // base64url
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  const b64 = btoa(str);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

async function importAesKeyFromB64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptString(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);

  // pack as base64url(iv) + '.' + base64url(ciphertext)
  const ivB64 = btoa(String.fromCharCode(...iv))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const ctArr = new Uint8Array(ciphertext);
  let ctStr = "";
  for (const b of ctArr) ctStr += String.fromCharCode(b);
  const ctB64 = btoa(ctStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  return `${ivB64}.${ctB64}`;
}

async function decryptString(key: CryptoKey, packed: string): Promise<string> {
  const [ivB64, ctB64] = packed.split(".");
  if (!ivB64 || !ctB64) throw new Error("Invalid ciphertext");

  const iv = Uint8Array.from(
    atob(ivB64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((ivB64.length + 3) % 4)),
    (c) => c.charCodeAt(0),
  );

  const ctBytes = Uint8Array.from(
    atob(ctB64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((ctB64.length + 3) % 4)),
    (c) => c.charCodeAt(0),
  );

  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ctBytes);
  return new TextDecoder().decode(plaintext);
}

function getUrls(env: Env): { authorizeUrl: string; tokenUrl: string; redirectUri: string } {
  const tokenUrl = env.ST_TOKEN_URL || "https://auth-global.api.smartthings.com/oauth/token";
  // NOTE: SmartThings authorization URL can vary by integration type/region.
  // Empirically, auth-global may respond with HTTP Basic auth; api.smartthings.com redirects to the correct user login/consent flow.
  const authorizeUrl = env.ST_AUTHORIZATION_URL || "https://api.smartthings.com/oauth/authorize";

  const redirectUri =
    env.ST_REDIRECT_URI || (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/+$/g, "")}/v1/callback` : "");
  if (!redirectUri) {
    throw new Error("Missing redirect URI: set ST_REDIRECT_URI or PUBLIC_BASE_URL");
  }

  return { authorizeUrl, tokenUrl, redirectUri };
}

function encodeScopesForSmartThings(scopes: string): string {
  // SmartThings examples show scopes like `r:devices:* x:devices:*`.
  // Some OAuth servers are surprisingly picky about percent-encoded ':' and '*',
  // so we keep them literal and only encode separators/spaces as '%20'.
  return scopes
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => encodeURIComponent(scope).replace(/%3A/gi, ":").replace(/%2A/gi, "*"))
    .join("%20");
}

async function exchangeCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const tokenUrl = env.ST_TOKEN_URL || "https://auth-global.api.smartthings.com/oauth/token";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.ST_CLIENT_ID,
    redirect_uri: redirectUri,
  });

  const basic = btoa(`${env.ST_CLIENT_ID}:${env.ST_CLIENT_SECRET}`);
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`,
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
}

async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const tokenUrl = env.ST_TOKEN_URL || "https://auth-global.api.smartthings.com/oauth/token";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.ST_CLIENT_ID,
  });

  const basic = btoa(`${env.ST_CLIENT_ID}:${env.ST_CLIENT_SECRET}`);
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`,
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
}

function htmlPage(title: string, bodyHtml: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.45}code{background:#f2f2f2;padding:2px 4px;border-radius:4px}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return withCors(req, new Response(null, { status: 204 }));
    }

    const respond = (r: Response) => withCors(req, r);

    if (req.method === "GET" && url.pathname === "/health") {
      return respond(json({ ok: true, time: nowIso() }));
    }

    // Minimal SmartThings Webhook SmartApp lifecycle endpoint.
    // SmartThings will call this URL to validate the webhook (PING/CONFIRMATION) when creating/updating a WEBHOOK_SMART_APP.
    if (req.method === "POST" && url.pathname === "/st/lifecycle") {
      let payload: any;
      try {
        payload = await req.json();
      } catch {
        return respond(badRequest("Invalid JSON"));
      }

      const lifecycle = String(payload?.lifecycle || "").toUpperCase();

      if (lifecycle === "PING") {
        const challenge = payload?.pingData?.challenge;
        if (!challenge || typeof challenge !== "string") {
          return respond(badRequest("Missing pingData.challenge"));
        }
        return respond(json({ pingData: { challenge } }));
      }

      if (lifecycle === "CONFIRMATION") {
        const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/g, "");
        return respond(json({ targetUrl: `${base}/st/lifecycle` }));
      }

      // For provisioning our OAuth client, we don't need a fully functional SmartApp.
      // Return 200 so SmartThings doesn't treat the webhook as completely broken.
      return respond(json({ ok: true }));
    }

    // Create a pairing session and return the authorize URL.
    if (req.method === "POST" && url.pathname === "/v1/pair") {
      // Use a hex-only state to avoid any overly strict OAuth parsers.
      const pairId = randomHex(18);
      const { authorizeUrl, redirectUri } = getUrls(env);

      // Optional debugging controls:
      // - /v1/pair?no_scope=1 -> omit scope param entirely
      // - /v1/pair?scopes=... -> override requested scopes (space-delimited)
      const noScope = url.searchParams.get("no_scope") === "1";
      const scopesOverride = url.searchParams.get("scopes");
      const scopes = (scopesOverride ?? env.ST_SCOPES ?? "r:devices:* x:devices:*").trim();
      const state = pairId;

      const encodedScopes = encodeScopesForSmartThings(scopes);

      // Build the authorize URL query string manually.
      // Reason: URLSearchParams encodes spaces as '+', but some OAuth servers are strict and expect '%20'.
      // Also, encoding '*' as '%2A' avoids edge cases with overly strict parsers.
      const authUrl = new URL(authorizeUrl);
      const queryParts = [
        `response_type=code`,
        `client_id=${encodeURIComponent(env.ST_CLIENT_ID)}`,
        `redirect_uri=${encodeURIComponent(redirectUri)}`,
        ...(noScope ? [] : [`scope=${encodedScopes}`]),
        `state=${encodeURIComponent(state)}`,
      ];
      authUrl.search = queryParts.join("&");

      const record: PairRecord = { status: "pending", createdAt: nowIso() };
      await env.AUTH_KV.put(`pair:${pairId}`, JSON.stringify(record), { expirationTtl: 15 * 60 });

      return respond(
        json({
          pairId,
          authorizationUrl: authUrl.toString(),
          expiresInSeconds: 15 * 60,
          debug: {
            authorizeUrl,
            redirectUri,
            scopes,
            noScope,
            clientId: env.ST_CLIENT_ID,
          },
        }),
      );
    }

    // OAuth callback from SmartThings.
    if (req.method === "GET" && url.pathname === "/v1/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      const oauthErrorDescription = url.searchParams.get("error_description");

      const rawQuery = url.search ? url.search.slice(1) : "";

      if (oauthError) {
        const msg = `SmartThings returned an OAuth error: ${oauthError}${oauthErrorDescription ? ` - ${oauthErrorDescription}` : ""}`;

        if (state) {
          const pairKey = `pair:${state}`;
          const pairRaw = await env.AUTH_KV.get(pairKey);
          if (pairRaw) {
            const pair = JSON.parse(pairRaw) as PairRecord;
            if (pair.status === "pending") {
              const updatedPair: PairRecord = { ...pair, status: "error", error: msg };
              await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });
            }
          }
        }

        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1>
             <p>${escapeHtml(msg)}</p>
             ${rawQuery ? `<h2>Callback Query</h2><pre>${escapeHtml(rawQuery)}</pre>` : ""}
             <p>Return to Raycast and try again.</p>`,
          ),
        );
      }
      if (!code || !state) {
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>Missing <code>code</code> or <code>state</code>.</p>`,
          ),
        );
      }

      const pairKey = `pair:${state}`;
      const pairRaw = await env.AUTH_KV.get(pairKey);
      if (!pairRaw) {
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>This login session is not recognized or has expired. Return to Raycast and try again.</p>`,
          ),
        );
      }

      const pair = JSON.parse(pairRaw) as PairRecord;
      if (pair.status !== "pending") {
        return respond(
          htmlPage(
            "SmartThings Auth",
            `<h1>Already connected</h1><p>You can close this tab and return to Raycast.</p>`,
          ),
        );
      }

      try {
        const { redirectUri } = getUrls(env);
        const tokenResp = await exchangeCodeForTokens(env, code, redirectUri);

        const aesKey = await importAesKeyFromB64(env.TOKEN_ENC_KEY_B64);
        const sessionToken = randomBase64Url(32);

        const accessTokenExpiresAt = addSeconds(nowIso(), tokenResp.expires_in);
        const tokenRecord: TokenRecord = {
          updatedAt: nowIso(),
          accessTokenEnc: await encryptString(aesKey, tokenResp.access_token),
          accessTokenExpiresAt,
          refreshTokenEnc: await encryptString(aesKey, tokenResp.refresh_token),
        };

        // Persist tokens keyed by session token (Raycast will store this session token).
        await env.AUTH_KV.put(`token:${sessionToken}`, JSON.stringify(tokenRecord));

        // Mark pair as completed so Raycast can poll for the session token.
        const updatedPair: PairRecord = { ...pair, status: "completed", sessionToken };
        await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });

        return respond(
          htmlPage(
            "SmartThings Auth - Connected",
            `<h1>Connected</h1>
             <p>You can close this tab and return to Raycast.</p>`,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const updatedPair: PairRecord = { ...pair, status: "error", error: msg };
        await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>${escapeHtml(msg)}</p><p>Return to Raycast and try again.</p>`,
          ),
        );
      }
    }

    // Poll pairing status (Raycast calls this until completed).
    if (req.method === "GET" && url.pathname.startsWith("/v1/pair/")) {
      const pairId = url.pathname.split("/").pop();
      if (!pairId) return respond(notFound());

      const pairRaw = await env.AUTH_KV.get(`pair:${pairId}`);
      if (!pairRaw) return respond(notFound());

      const pair = JSON.parse(pairRaw) as PairRecord;
      // Return sessionToken only once it exists.
      return respond(json({ status: pair.status, sessionToken: pair.sessionToken, error: pair.error }));
    }

    // Return a valid SmartThings access token (refreshing if needed).
    if (req.method === "POST" && url.pathname === "/v1/access-token") {
      const sessionToken = getBearerToken(req);
      if (!sessionToken) return respond(unauthorized());

      const tokenKey = `token:${sessionToken}`;
      const tokenRaw = await env.AUTH_KV.get(tokenKey);
      if (!tokenRaw) return respond(unauthorized("Invalid session"));

      const aesKey = await importAesKeyFromB64(env.TOKEN_ENC_KEY_B64);
      const record = JSON.parse(tokenRaw) as TokenRecord;

      const expiresAt = new Date(record.accessTokenExpiresAt).getTime();
      const now = Date.now();

      // If token is still valid for at least 60 seconds, return it.
      if (expiresAt - now > 60_000) {
        const accessToken = await decryptString(aesKey, record.accessTokenEnc);
        return respond(json({ accessToken, expiresAt: record.accessTokenExpiresAt }));
      }

      // Refresh.
      const refreshToken = await decryptString(aesKey, record.refreshTokenEnc);
      const refreshed = await refreshAccessToken(env, refreshToken);

      const newExpiresAt = addSeconds(nowIso(), refreshed.expires_in);
      const newRecord: TokenRecord = {
        updatedAt: nowIso(),
        accessTokenEnc: await encryptString(aesKey, refreshed.access_token),
        accessTokenExpiresAt: newExpiresAt,
        refreshTokenEnc: refreshed.refresh_token
          ? await encryptString(aesKey, refreshed.refresh_token)
          : record.refreshTokenEnc,
      };

      await env.AUTH_KV.put(tokenKey, JSON.stringify(newRecord));

      return respond(json({ accessToken: refreshed.access_token, expiresAt: newExpiresAt }));
    }

    // Logout (delete stored tokens).
    if (req.method === "POST" && url.pathname === "/v1/logout") {
      const sessionToken = getBearerToken(req);
      if (!sessionToken) return respond(unauthorized());
      await env.AUTH_KV.delete(`token:${sessionToken}`);
      return respond(json({ ok: true }));
    }

    return respond(notFound());
  },
};
