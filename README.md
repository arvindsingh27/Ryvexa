# Nexlytics

Static frontend (`public/index.html`) + Netlify Functions for the live Instagram integration.

## Environment variables (Netlify → Project configuration → Environment variables)
- `INSTAGRAM_APP_ID` – Instagram app ID (Meta → Instagram → API setup with Instagram login)
- `INSTAGRAM_APP_SECRET` – Instagram app secret (mark as secret)
- `INSTAGRAM_REDIRECT_URI` – `https://<your-site>.netlify.app/api/oauth/instagram/callback`
- `TOKEN_ENCRYPTION_KEY` – optional; defaults to a key derived from the app secret
- `IG_GRAPH_VERSION` – optional; defaults to `v23.0`

## Routes
- `GET /api/oauth/instagram/start` – redirects to Instagram consent (CSRF state cookie)
- `GET /api/oauth/instagram/callback` – exchanges code → long-lived token, stores it AES-GCM encrypted in Netlify Blobs
- `GET /api/instagram/status|profile|media|insights?range=28|audience`
- `POST /api/instagram/disconnect` – deletes token and cache

Tokens never reach the browser; the browser only holds an HttpOnly session cookie.
