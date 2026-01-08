# Copilot instructions — SmartThings Home Control

## Big picture

- This repo is a **Raycast extension** that talks to Samsung SmartThings, but **OAuth + refresh tokens are handled by a Cloudflare Worker**.
- The Raycast side stores only an **opaque session token** in Raycast `LocalStorage` (`smartthings_session_token`). The Worker stores encrypted SmartThings tokens in KV.

### Components

- Raycast command UI + SmartThings device control: `src/list-devices.tsx`
  - Preference `brokerBaseUrl` points at the Worker (see extension schema in `package.json`).
  - Auth flow: `ensureConnected()` calls Worker `POST /v1/pair`, opens `authorizationUrl`, then polls `GET /v1/pair/:pairId` until it receives `sessionToken`.
  - Data flow: `POST /v1/access-token` (Worker) → SmartThings REST (`https://api.smartthings.com/v1/...`).
- Auth broker Worker: `worker/src/index.ts`
  - KV keys: `pair:${pairId}` (15 min TTL) and `token:${sessionToken}` (encrypted tokens).
  - Routes:
    - `POST /v1/pair` → returns `{ pairId, authorizationUrl }`
    - `GET /v1/callback` → OAuth redirect URI; exchanges code, writes KV
    - `GET /v1/pair/:pairId` → Raycast polls status/session token
    - `POST /v1/access-token` (Bearer session token) → returns valid SmartThings access token (refreshes when near-expired)
    - `POST /v1/logout` → deletes `token:${sessionToken}`

## Local development

- Raycast extension (root):
  - `npm run dev` (runs `ray develop`)
  - `npm run lint` / `npm run fix-lint` / `npm run build`
- Worker (in `worker/`):
  - `npm run dev` (Wrangler)
  - `npm run typecheck`
  - Local env vars live in `worker/.dev.vars` (copy from `worker/.dev.vars.example`).
  - `AUTH_KV` binding is defined in `worker/wrangler.toml` with placeholder IDs for `wrangler dev --local` smoke tests.

### Worker config quick notes

- Binding: `AUTH_KV` (Cloudflare KV)
- Vars: `ST_CLIENT_ID`, `PUBLIC_BASE_URL` (or `ST_REDIRECT_URI`), optional `ST_SCOPES`
- Secrets: `ST_CLIENT_SECRET`, `TOKEN_ENC_KEY_B64`

### End-to-end dev loop (auth + devices)

1. Start Worker locally from `worker/` with `npm run dev` (usually on `http://localhost:8787`).
2. Set `PUBLIC_BASE_URL` in `worker/.dev.vars` to the same origin Wrangler prints (used to build `${PUBLIC_BASE_URL}/v1/callback`).
3. In Raycast, set the command preference `brokerBaseUrl` to `http://localhost:8787`.

## Project conventions to follow

- Prefer the existing small helpers in `src/list-devices.tsx`:
  - `fetchJson<T>()` for HTTP + error text
  - `mapWithConcurrency(..., 6, ...)` for per-device status fanout
  - Capability checks via `deviceHasCapability(device, "switch")`, then use SmartThings capability-specific endpoints.
- Raycast data fetching is done via `useCachedPromise(..., { keepPreviousData: true })` and `revalidate()` for refresh.
- Worker token storage is **AES-GCM encrypted** with `TOKEN_ENC_KEY_B64` (see `worker/README.md`). Don’t store SmartThings tokens on the Raycast side.

## CI / automation

- GitHub Actions only includes CodeQL scanning: `.github/workflows/codeql.yml`.
- No repo-level unit test runner is configured; keep changes small and validate via `ray build` and/or running the Worker locally.