# SmartThings Auth Worker (Cloudflare)

This Cloudflare Worker handles SmartThings OAuth and stores refresh tokens server-side.
The Raycast extension stores only an opaque `sessionToken`.

## What it does

- `POST /v1/pair` creates a short-lived pairing session and returns a SmartThings `authorizationUrl`.
- `GET /v1/callback` is the OAuth redirect URI; it exchanges the auth code for tokens and stores them.
- `GET /v1/pair/:pairId` lets the Raycast extension poll until it gets a `sessionToken`.
- `POST /v1/access-token` returns a valid SmartThings `accessToken` (refreshing if needed).
- `POST /v1/logout` deletes stored tokens.

## Cloudflare setup

### KV

Create a KV namespace and bind it as `AUTH_KV`.

### Secrets

Set these as Worker secrets:

- `ST_CLIENT_SECRET` — SmartThings OAuth client secret
- `TOKEN_ENC_KEY_B64` — base64-encoded 32-byte key (AES-GCM)

Generate `TOKEN_ENC_KEY_B64` locally (PowerShell):

```powershell
$bytes = New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes);
[Convert]::ToBase64String($bytes)
```

### Variables

Set these as Worker vars:

- `ST_CLIENT_ID`
- `PUBLIC_BASE_URL` (or `ST_REDIRECT_URI`)
- `ST_SCOPES` (optional; default `r:devices:* x:devices:*`)
- `ST_AUTHORIZATION_URL` (optional override)
- `ST_TOKEN_URL` (optional override; default `https://auth-global.api.smartthings.com/oauth/token`)

**Important:** Your SmartThings app must whitelist the redirect URI used by the worker. By default it uses:

- `${PUBLIC_BASE_URL}/v1/callback`

## Local dev

From this folder:

```bash
npm install
npm run dev
```

Wrangler can load local variables from a `.dev.vars` file. Start from the example:

```bash
copy .dev.vars.example .dev.vars
```

Then edit `.dev.vars` with your values.

Local dev also needs an `AUTH_KV` binding. This repo includes a placeholder KV binding in `wrangler.toml` so `wrangler dev --local` can simulate KV for smoke tests.

If your environment is configured to omit devDependencies (e.g. `omit=dev`), use:

```bash
npm install --include=dev
```

## Deploy

```bash
npm run deploy
```

Or connect Cloudflare Pages/Workers to this GitHub repo and set the **root directory** to `worker/`.
