# Frontlift Generator

Automated Cloudflare Worker backend for Frontlift. It accepts a public business website URL, extracts readable content, uses Workers AI to generate a factual conversion-focused redesign package, and returns structured JSON to the Base44 frontend.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lyfttt/frontlift-worker)

## Endpoints

- `GET /health` — deployment and Workers AI health check.
- `POST /generate` — generate a redesign package.
- `POST /api/generate` — alias for Base44 integrations.

Example request:

```json
{
  "url": "https://example-business.com",
  "businessName": "Example Business",
  "notes": "Optional customer notes"
}
```

## Automation flow

1. The Base44 form sends the submitted website to `/generate`.
2. The Worker validates the URL and fetches the public website.
3. Workers AI produces structured redesign and sales content.
4. The JSON response is rendered in Base44 and can be saved with the lead.

## Configuration

Workers AI is bound automatically as `AI` through `wrangler.toml`.

For production, optionally set `ALLOWED_ORIGINS` to a comma-separated list of the Base44 production and preview origins. It defaults to `*` so the first deployment works immediately.

## Local commands

```bash
npm install
npm run dev
npm run deploy
```
