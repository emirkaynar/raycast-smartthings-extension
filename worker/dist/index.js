var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};
function escapeHtml(input) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml, "escapeHtml");
function withCors(req, resp) {
  const headers = new Headers(resp.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-max-age", "86400");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers
  });
}
__name(withCors, "withCors");
function json(data, init) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init?.headers || {}
    }
  });
}
__name(json, "json");
function unauthorized(message = "Unauthorized") {
  return json({ error: message }, { status: 401 });
}
__name(unauthorized, "unauthorized");
function notFound() {
  return json({ error: "Not Found" }, { status: 404 });
}
__name(notFound, "notFound");
function randomBase64Url(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  const b64 = btoa(str);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(randomBase64Url, "randomBase64Url");
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}
__name(randomHex, "randomHex");
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function trimTrailingSlashes(input) {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--;
  return end === input.length ? input : input.slice(0, end);
}
__name(trimTrailingSlashes, "trimTrailingSlashes");
function splitOnAsciiWhitespace(input) {
  const parts = [];
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
__name(splitOnAsciiWhitespace, "splitOnAsciiWhitespace");
function addSeconds(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1e3).toISOString();
}
__name(addSeconds, "addSeconds");
function getBearerToken(req) {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}
__name(getBearerToken, "getBearerToken");
async function importAesKeyFromB64(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
__name(importAesKeyFromB64, "importAesKeyFromB64");
async function encryptString(key, plaintext) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const ivB64 = btoa(String.fromCharCode(...iv)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const ctArr = new Uint8Array(ciphertext);
  let ctStr = "";
  for (const b of ctArr) ctStr += String.fromCharCode(b);
  const ctB64 = btoa(ctStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${ivB64}.${ctB64}`;
}
__name(encryptString, "encryptString");
async function decryptString(key, packed) {
  const [ivB64, ctB64] = packed.split(".");
  if (!ivB64 || !ctB64) throw new Error("Invalid ciphertext");
  const iv = Uint8Array.from(
    atob(ivB64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((ivB64.length + 3) % 4)),
    (c) => c.charCodeAt(0)
  );
  const ctBytes = Uint8Array.from(
    atob(ctB64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((ctB64.length + 3) % 4)),
    (c) => c.charCodeAt(0)
  );
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ctBytes);
  return new TextDecoder().decode(plaintext);
}
__name(decryptString, "decryptString");
function getUrls(env) {
  const tokenUrl = env.ST_TOKEN_URL || "https://auth-global.api.smartthings.com/oauth/token";
  const authorizeUrl = env.ST_AUTHORIZATION_URL || "https://api.smartthings.com/oauth/authorize";
  const redirectUri = env.ST_REDIRECT_URI || (env.PUBLIC_BASE_URL ? `${trimTrailingSlashes(env.PUBLIC_BASE_URL)}/v1/callback` : "");
  if (!redirectUri) {
    throw new Error("Missing redirect URI: set ST_REDIRECT_URI or PUBLIC_BASE_URL");
  }
  return { authorizeUrl, tokenUrl, redirectUri };
}
__name(getUrls, "getUrls");
function encodeScopesForSmartThings(scopes) {
  return splitOnAsciiWhitespace(scopes).map(
    (scope) => encodeURIComponent(scope).replaceAll("%3A", ":").replaceAll("%3a", ":").replaceAll("%2A", "*").replaceAll("%2a", "*")
  ).join("%20");
}
__name(encodeScopesForSmartThings, "encodeScopesForSmartThings");
async function exchangeCodeForTokens(env, code, redirectUri) {
  const tokenUrl = env.ST_TOKEN_URL || "https://auth-global.api.smartthings.com/oauth/token";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.ST_CLIENT_ID,
    redirect_uri: redirectUri
  });
  const basic = btoa(`${env.ST_CLIENT_ID}:${env.ST_CLIENT_SECRET}`);
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`
    },
    body
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }
  return JSON.parse(text);
}
__name(exchangeCodeForTokens, "exchangeCodeForTokens");
async function refreshAccessToken(env, refreshToken) {
  const tokenUrl = env.ST_TOKEN_URL || "https://auth-global.api.smartthings.com/oauth/token";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.ST_CLIENT_ID
  });
  const basic = btoa(`${env.ST_CLIENT_ID}:${env.ST_CLIENT_SECRET}`);
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`
    },
    body
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }
  return JSON.parse(text);
}
__name(refreshAccessToken, "refreshAccessToken");
function htmlPage(title, bodyHtml) {
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
      "cache-control": "no-store"
    }
  });
}
__name(htmlPage, "htmlPage");
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return withCors(req, new Response(null, { status: 204 }));
    }
    const respond = /* @__PURE__ */ __name((r) => withCors(req, r), "respond");
    if (req.method === "GET" && url.pathname === "/health") {
      return respond(json({ ok: true, time: nowIso() }));
    }
    if (req.method === "POST" && url.pathname === "/v1/pair") {
      const pairId = randomHex(18);
      const { authorizeUrl, redirectUri } = getUrls(env);
      const noScope = url.searchParams.get("no_scope") === "1";
      const scopesOverride = url.searchParams.get("scopes");
      const scopes = (scopesOverride ?? env.ST_SCOPES ?? "r:devices:* x:devices:*").trim();
      const state = pairId;
      const encodedScopes = encodeScopesForSmartThings(scopes);
      const authUrl = new URL(authorizeUrl);
      const queryParts = [
        `response_type=code`,
        `client_id=${encodeURIComponent(env.ST_CLIENT_ID)}`,
        `redirect_uri=${encodeURIComponent(redirectUri)}`,
        ...noScope ? [] : [`scope=${encodedScopes}`],
        `state=${encodeURIComponent(state)}`
      ];
      authUrl.search = queryParts.join("&");
      const record = { status: "pending", createdAt: nowIso() };
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
            clientId: env.ST_CLIENT_ID
          }
        })
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      const oauthErrorDescription = url.searchParams.get("error_description");
      const rawQuery = url.search ? url.search.slice(1) : "";
      if (oauthError) {
        const msg = `SmartThings returned an OAuth error: ${oauthError}${oauthErrorDescription ? ` - ${oauthErrorDescription}` : ""}`;
        if (state) {
          const pairKey2 = `pair:${state}`;
          const pairRaw2 = await env.AUTH_KV.get(pairKey2);
          if (pairRaw2) {
            const pair2 = JSON.parse(pairRaw2);
            if (pair2.status === "pending") {
              const updatedPair = { ...pair2, status: "error", error: msg };
              await env.AUTH_KV.put(pairKey2, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });
            }
          }
        }
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1>
             <p>${escapeHtml(msg)}</p>
             ${rawQuery ? `<h2>Callback Query</h2><pre>${escapeHtml(rawQuery)}</pre>` : ""}
             <p>Return to Raycast and try again.</p>`
          )
        );
      }
      if (!code || !state) {
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>Missing <code>code</code> or <code>state</code>.</p>`
          )
        );
      }
      const pairKey = `pair:${state}`;
      const pairRaw = await env.AUTH_KV.get(pairKey);
      if (!pairRaw) {
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>This login session is not recognized or has expired. Return to Raycast and try again.</p>`
          )
        );
      }
      const pair = JSON.parse(pairRaw);
      if (pair.status !== "pending") {
        return respond(
          htmlPage(
            "SmartThings Auth",
            `<h1>Already connected</h1><p>You can close this tab and return to Raycast.</p>`
          )
        );
      }
      try {
        const { redirectUri } = getUrls(env);
        const tokenResp = await exchangeCodeForTokens(env, code, redirectUri);
        const aesKey = await importAesKeyFromB64(env.TOKEN_ENC_KEY_B64);
        const sessionToken = randomBase64Url(32);
        const accessTokenExpiresAt = addSeconds(nowIso(), tokenResp.expires_in);
        const tokenRecord = {
          updatedAt: nowIso(),
          accessTokenEnc: await encryptString(aesKey, tokenResp.access_token),
          accessTokenExpiresAt,
          refreshTokenEnc: await encryptString(aesKey, tokenResp.refresh_token)
        };
        await env.AUTH_KV.put(`token:${sessionToken}`, JSON.stringify(tokenRecord));
        const updatedPair = { ...pair, status: "completed", sessionToken };
        await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });
        return respond(
          htmlPage(
            "SmartThings Auth - Connected",
            `<h1>Connected</h1>
             <p>You can close this tab and return to Raycast.</p>`
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const updatedPair = { ...pair, status: "error", error: msg };
        await env.AUTH_KV.put(pairKey, JSON.stringify(updatedPair), { expirationTtl: 15 * 60 });
        return respond(
          htmlPage(
            "SmartThings Auth - Error",
            `<h1>Authentication failed</h1><p>${escapeHtml(msg)}</p><p>Return to Raycast and try again.</p>`
          )
        );
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/pair/")) {
      const pairId = url.pathname.split("/").pop();
      if (!pairId) return respond(notFound());
      const pairRaw = await env.AUTH_KV.get(`pair:${pairId}`);
      if (!pairRaw) return respond(notFound());
      const pair = JSON.parse(pairRaw);
      return respond(json({ status: pair.status, sessionToken: pair.sessionToken, error: pair.error }));
    }
    if (req.method === "POST" && url.pathname === "/v1/access-token") {
      const sessionToken = getBearerToken(req);
      if (!sessionToken) return respond(unauthorized());
      const tokenKey = `token:${sessionToken}`;
      const tokenRaw = await env.AUTH_KV.get(tokenKey);
      if (!tokenRaw) return respond(unauthorized("Invalid session"));
      const aesKey = await importAesKeyFromB64(env.TOKEN_ENC_KEY_B64);
      const record = JSON.parse(tokenRaw);
      const expiresAt = new Date(record.accessTokenExpiresAt).getTime();
      const now = Date.now();
      if (expiresAt - now > 6e4) {
        const accessToken = await decryptString(aesKey, record.accessTokenEnc);
        return respond(json({ accessToken, expiresAt: record.accessTokenExpiresAt }));
      }
      const refreshToken = await decryptString(aesKey, record.refreshTokenEnc);
      const refreshed = await refreshAccessToken(env, refreshToken);
      const newExpiresAt = addSeconds(nowIso(), refreshed.expires_in);
      const newRecord = {
        updatedAt: nowIso(),
        accessTokenEnc: await encryptString(aesKey, refreshed.access_token),
        accessTokenExpiresAt: newExpiresAt,
        refreshTokenEnc: refreshed.refresh_token ? await encryptString(aesKey, refreshed.refresh_token) : record.refreshTokenEnc
      };
      await env.AUTH_KV.put(tokenKey, JSON.stringify(newRecord));
      return respond(json({ accessToken: refreshed.access_token, expiresAt: newExpiresAt }));
    }
    if (req.method === "POST" && url.pathname === "/v1/logout") {
      const sessionToken = getBearerToken(req);
      if (!sessionToken) return respond(unauthorized());
      await env.AUTH_KV.delete(`token:${sessionToken}`);
      return respond(json({ ok: true }));
    }
    return respond(notFound());
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
