# Ship Browser SPA — Authorization Code + PKCE Demo

A minimal single-page app that demonstrates the **Authorization Code + PKCE** flow
against Ship's OAuth server (`/oauth/authorize` → `/oauth/token`) and then lists
the authenticated user's documents from `/api/v1/documents`.

## Prerequisites

- Ship API running locally (default `http://localhost:3000`).
- Migration `045_plugforge_spa_app.sql` applied (adds the `ship_app_spa` public OAuth app).
- Node ≥ 18, pnpm.

## Run

```bash
# From the repo root:
pnpm install

# Start the SPA dev server (http://localhost:5180):
pnpm --filter @ship/browser-spa dev
```

Open **http://localhost:5180** in your browser.

1. Click **Sign in with Ship**.  
   The app generates a PKCE verifier + S256 challenge, stores the verifier in
   `sessionStorage`, then redirects to `/oauth/authorize`.
2. Log into Ship and approve the consent screen.  
   Ship redirects back to `http://localhost:5180/callback?code=…&state=…`.
3. The SPA exchanges the code at `/oauth/token` (no client secret — public client)
   using the stored verifier, receives an access token, and calls
   `/api/v1/documents`, rendering each document's title.

## Configuration

Override defaults via a `.env.local` file (Vite):

```
VITE_SHIP_BASE_URL=http://localhost:3000
VITE_CLIENT_ID=ship_app_spa
```

Or register additional redirect URIs in migration `045` for other ports.

## Tests

```bash
pnpm --filter @ship/browser-spa test
```

Tests the PKCE helper (`src/pkce.ts`) in Node — verifier generation, S256
challenge computation, and base64url encoding are all unit-tested without a
browser or running server.

## Security notes

- The access token is stored **in-memory only** (no `localStorage`) to limit XSS exposure.
- The PKCE verifier lives in `sessionStorage` only for the duration of the redirect round-trip.
- The `state` nonce prevents CSRF on the callback.
- `code` and `state` are stripped from the URL via `history.replaceState` after exchange.
