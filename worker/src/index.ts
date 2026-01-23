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
  lastUsedAt: string;
  accessTokenEnc: string;
  accessTokenExpiresAt: string; // ISO
  refreshTokenEnc: string;
};

// --- Rate Limiting ---
type RateLimitEntry = { count: number; resetAt: number };
const rateLimitMap = new Map<string, RateLimitEntry>();

const RATE_LIMITS = {
  pair: { limit: 10, windowMs: 60_000 },
  accessToken: { limit: 60, windowMs: 60_000 },
  pairPoll: { limit: 120, windowMs: 60_000 },
  global: { limit: 300, windowMs: 60_000 },
} as const;

function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= limit) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodic cleanup of stale entries (runs lazily)
let lastCleanup = 0;
function cleanupRateLimitMap(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return; // cleanup at most once per minute
  lastCleanup = now;
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  }
}

// --- Cached AES Key ---
let cachedAesKey: CryptoKey | null = null;
let cachedKeyB64: string | null = null;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function tooManyRequests(): Response {
  return json({ error: "Too many requests" }, { status: 429 });
}

function internalError(message = "Internal server error"): Response {
  return json({ error: message }, { status: 500 });
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

function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // '/'
  return end === input.length ? input : input.slice(0, end);
}

function splitOnAsciiWhitespace(input: string): string[] {
  const parts: string[] = [];
  let tokenStart = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    const isWs = ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 11;
    if (isWs) {
      if (tokenStart !== -1) {
        parts.push(input.slice(tokenStart, i));
        tokenStart = -1;
      }
      continue;
    }
    if (tokenStart === -1) tokenStart = i;
  }

  if (tokenStart !== -1) parts.push(input.slice(tokenStart));
  return parts;
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
  // Return cached key if available and key hasn't changed
  if (cachedAesKey && cachedKeyB64 === b64) {
    return cachedAesKey;
  }
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedAesKey = key;
  cachedKeyB64 = b64;
  return key;
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
    env.ST_REDIRECT_URI || (env.PUBLIC_BASE_URL ? `${trimTrailingSlashes(env.PUBLIC_BASE_URL)}/v1/callback` : "");
  if (!redirectUri) {
    throw new Error("Missing redirect URI: set ST_REDIRECT_URI or PUBLIC_BASE_URL");
  }

  return { authorizeUrl, tokenUrl, redirectUri };
}

function encodeScopesForSmartThings(scopes: string): string {
  // SmartThings examples show scopes like `r:devices:* x:devices:*`.
  // Some OAuth servers are surprisingly picky about percent-encoded ':' and '*',
  // so we keep them literal and only encode separators/spaces as '%20'.
  return splitOnAsciiWhitespace(scopes)
    .map((scope) =>
      encodeURIComponent(scope)
        .replaceAll("%3A", ":")
        .replaceAll("%3a", ":")
        .replaceAll("%2A", "*")
        .replaceAll("%2a", "*"),
    )
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
    console.error(JSON.stringify({ event: "token_exchange_failed", status: resp.status, body: text }));
    throw new Error(`Token exchange failed (${resp.status})`);
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
    console.error(JSON.stringify({ event: "token_refresh_failed", status: resp.status, body: text }));
    throw new Error(`Token refresh failed (${resp.status})`);
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
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const clientIp = req.headers.get("cf-connecting-ip") || "unknown";

    // Periodic cleanup of rate limit map
    cleanupRateLimitMap();

    // Global rate limit check
    if (!checkRateLimit(`global:${clientIp}`, RATE_LIMITS.global.limit, RATE_LIMITS.global.windowMs)) {
      console.log(JSON.stringify({ event: "rate_limit_hit", ip: clientIp, endpoint: "global" }));
      return tooManyRequests();
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, time: nowIso() });
      }

      // Create a pairing session and return the authorize URL.
      if (req.method === "POST" && url.pathname === "/v1/pair") {
        // Rate limit pair creation
        if (!checkRateLimit(`pair:${clientIp}`, RATE_LIMITS.pair.limit, RATE_LIMITS.pair.windowMs)) {
          console.log(JSON.stringify({ event: "rate_limit_hit", ip: clientIp, endpoint: "pair" }));
          return tooManyRequests();
        }

        // Use a hex-only state to avoid any overly strict OAuth parsers.
        const pairId = randomHex(18);
        const { authorizeUrl, redirectUri } = getUrls(env);

        const scopes = (env.ST_SCOPES ?? "r:devices:* x:devices:*").trim();
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
          `scope=${encodedScopes}`,
          `state=${encodeURIComponent(state)}`,
        ];
        authUrl.search = queryParts.join("&");

        const record: PairRecord = { status: "pending", createdAt: nowIso() };
        await env.AUTH_KV.put(`pair:${pairId}`, JSON.stringify(record), { expirationTtl: 15 * 60 });

        console.log(JSON.stringify({ event: "pair_created", pairId, ip: clientIp }));

        return json({
          pairId,
          authorizationUrl: authUrl.toString(),
          expiresInSeconds: 15 * 60,
        });
      }

      // OAuth callback from SmartThings.
      if (req.method === "GET" && url.pathname === "/v1/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const oauthError = url.searchParams.get("error");
        const oauthErrorDescription = url.searchParams.get("error_description");

        const rawQuery = url.search ? url.search.slice(1) : "";

        // Validate state format (36-char hex)
        if (state && !/^[a-f0-9]{36}$/.test(state)) {
          console.log(JSON.stringify({ event: "callback_invalid_state", state, ip: clientIp }));
          return htmlPage("SmartThings Auth - Error", `<h1>Authentication failed</h1><p>Invalid session state.</p>`);
        }

        if (oauthError) {
          const msg = `SmartThings returned an OAuth error: ${oauthError}${oauthErrorDescription ? ` - ${oauthErrorDescription}` : ""}`;
          console.log(JSON.stringify({ event: "callback_oauth_error", ip: clientIp }));

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

          return htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1>
             <p>${escapeHtml(msg)}</p>
             ${rawQuery ? `<h2>Callback Query</h2><pre>${escapeHtml(rawQuery)}</pre>` : ""}
             <p>Return to Raycast and try again.</p>`,
          );
        }
        if (!code || !state) {
          return htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>Missing <code>code</code> or <code>state</code>.</p>`,
          );
        }

        const pairKey = `pair:${state}`;
        const pairRaw = await env.AUTH_KV.get(pairKey);
        if (!pairRaw) {
          return htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>This login session is not recognized or has expired. Return to Raycast and try again.</p>`,
          );
        }

        const pair = JSON.parse(pairRaw) as PairRecord;
        if (pair.status !== "pending") {
          return htmlPage(
            "SmartThings Auth",
            `<h1>Already connected</h1><p>You can close this tab and return to Raycast.</p>`,
          );
        }

        try {
          const { redirectUri } = getUrls(env);
          const tokenResp = await exchangeCodeForTokens(env, code, redirectUri);

          const aesKey = await importAesKeyFromB64(env.TOKEN_ENC_KEY_B64);
          const sessionToken = randomBase64Url(32);

          const now = nowIso();
          const accessTokenExpiresAt = addSeconds(now, tokenResp.expires_in);
          const tokenRecord: TokenRecord = {
            updatedAt: now,
            lastUsedAt: now,
            accessTokenEnc: await encryptString(aesKey, tokenResp.access_token),
            accessTokenExpiresAt,
            refreshTokenEnc: await encryptString(aesKey, tokenResp.refresh_token),
          };

          // Persist tokens with 60-day TTL (sliding window on access)
          const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days
          await env.AUTH_KV.put(`token:${sessionToken}`, JSON.stringify(tokenRecord), {
            expirationTtl: SESSION_TTL_SECONDS,
          });

          // Mark pair as completed so Raycast can poll for the session token.
          const updatedPair: PairRecord = { ...pair, status: "completed", sessionToken };
          await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });

          console.log(JSON.stringify({ event: "auth_success", pairId: state, ip: clientIp }));

          return htmlPage(
            "SmartThings Auth - Connected",
            `<h1>Connected</h1>
             <p>You can close this tab and return to Raycast.</p>`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(JSON.stringify({ event: "auth_failed", pairId: state, error: msg, ip: clientIp }));
          const updatedPair: PairRecord = { ...pair, status: "error", error: msg };
          await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });
          return htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>${escapeHtml(msg)}</p><p>Return to Raycast and try again.</p>`,
          );
        }
      }

      // Poll pairing status (Raycast calls this until completed).
      if (req.method === "GET" && url.pathname.startsWith("/v1/pair/")) {
        // Rate limit polling
        if (!checkRateLimit(`pairPoll:${clientIp}`, RATE_LIMITS.pairPoll.limit, RATE_LIMITS.pairPoll.windowMs)) {
          console.log(JSON.stringify({ event: "rate_limit_hit", ip: clientIp, endpoint: "pairPoll" }));
          return tooManyRequests();
        }

        const pairId = url.pathname.split("/").pop();
        // Validate pairId format (36-char hex)
        if (!pairId || !/^[a-f0-9]{36}$/.test(pairId)) {
          return notFound();
        }

        const pairRaw = await env.AUTH_KV.get(`pair:${pairId}`);
        if (!pairRaw) return notFound();

        const pair = JSON.parse(pairRaw) as PairRecord;
        // Return sessionToken only once it exists.
        return json({ status: pair.status, sessionToken: pair.sessionToken, error: pair.error });
      }

      // Return a valid SmartThings access token (refreshing if needed).
      if (req.method === "POST" && url.pathname === "/v1/access-token") {
        // Rate limit access token requests
        if (
          !checkRateLimit(`accessToken:${clientIp}`, RATE_LIMITS.accessToken.limit, RATE_LIMITS.accessToken.windowMs)
        ) {
          console.log(JSON.stringify({ event: "rate_limit_hit", ip: clientIp, endpoint: "accessToken" }));
          return tooManyRequests();
        }

        const sessionToken = getBearerToken(req);
        if (!sessionToken) {
          console.log(JSON.stringify({ event: "auth_missing_token", ip: clientIp }));
          return unauthorized();
        }

        const tokenKey = `token:${sessionToken}`;
        const tokenRaw = await env.AUTH_KV.get(tokenKey);
        if (!tokenRaw) {
          console.log(JSON.stringify({ event: "auth_invalid_session", ip: clientIp }));
          return unauthorized("Invalid session");
        }

        const aesKey = await importAesKeyFromB64(env.TOKEN_ENC_KEY_B64);
        const record = JSON.parse(tokenRaw) as TokenRecord;

        const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days
        const expiresAt = new Date(record.accessTokenExpiresAt).getTime();
        const now = Date.now();

        // If token is still valid for at least 60 seconds, return it.
        if (expiresAt - now > 60_000) {
          // Update lastUsedAt and refresh TTL (sliding window)
          const updatedRecord: TokenRecord = { ...record, lastUsedAt: nowIso() };
          await env.AUTH_KV.put(tokenKey, JSON.stringify(updatedRecord), {
            expirationTtl: SESSION_TTL_SECONDS,
          });

          const accessToken = await decryptString(aesKey, record.accessTokenEnc);
          return json({ accessToken, expiresAt: record.accessTokenExpiresAt });
        }

        // Refresh the SmartThings access token.
        const refreshToken = await decryptString(aesKey, record.refreshTokenEnc);
        const refreshed = await refreshAccessToken(env, refreshToken);

        const nowTime = nowIso();
        const newExpiresAt = addSeconds(nowTime, refreshed.expires_in);
        const newRecord: TokenRecord = {
          updatedAt: nowTime,
          lastUsedAt: nowTime,
          accessTokenEnc: await encryptString(aesKey, refreshed.access_token),
          accessTokenExpiresAt: newExpiresAt,
          refreshTokenEnc: refreshed.refresh_token
            ? await encryptString(aesKey, refreshed.refresh_token)
            : record.refreshTokenEnc,
        };

        await env.AUTH_KV.put(tokenKey, JSON.stringify(newRecord), {
          expirationTtl: SESSION_TTL_SECONDS,
        });

        console.log(JSON.stringify({ event: "token_refreshed", ip: clientIp }));
        return json({ accessToken: refreshed.access_token, expiresAt: newExpiresAt });
      }

      // Logout (delete stored tokens).
      if (req.method === "POST" && url.pathname === "/v1/logout") {
        const sessionToken = getBearerToken(req);
        if (!sessionToken) return unauthorized();
        await env.AUTH_KV.delete(`token:${sessionToken}`);
        console.log(JSON.stringify({ event: "logout", ip: clientIp }));
        return json({ ok: true });
      }

      return notFound();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "unhandled_error",
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
        }),
      );
      return internalError();
    }
  },
};
