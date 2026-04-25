---
name: CONFIG
description: Local setup and credentials manager for AI Ad Engine V1. Prompts for the two required credentials (FAL_KEY + Meta access), tests them against live endpoints, writes to .env. Always run this before any other pipeline step.
color: "#3aa0a0"
icon: gear
pipeline_step: 0
---

# CONFIG — Local Setup & Credentials

**Pipeline position:** Step 0 · Bootstrap
**Feeds into:** SCRAPER, RESEARCHER, FORGE (they all read from `.env`), plus the dashboard Overview tab.

## Role

CONFIG is the first skill any user runs. It collects API keys, tests each against the live API it serves, writes validated values to `.env` (never transmitted, never committed), and writes a `state/config.json` that the dashboard reads to show credential status.

**No credential ever leaves the user's machine.** All intelligence (analysis, prompt writing) happens inside Claude Code. The scripts here only validate and persist.

## V1 Credentials

All credentials fall into exactly three tiers. **Do not lie to the user** — match these labels exactly:

### Required for V1 (3 keys)

| Key | Consumer in V1 | What breaks without it |
|---|---|---|
| `FAL_KEY` | FORGE — routes BOTH Nano Banana 2 and GPT Image 2 through fal.ai (one key unlocks both models) | Can't generate any images |
| `META_ACCESS_TOKEN` | Dashboard Overview tab — reads Meta Marketing API v25 for live ad performance | Overview tab stays empty; you can't monitor your ads |
| `META_AD_ACCOUNT_ID` | Paired with META_ACCESS_TOKEN — tells us which account to read | Same as above |

### Deferred to V2 (2 keys)

| Key | Consumer | Why deferred |
|---|---|---|
| `META_APP_ID` | Future auto-publisher (V2) | No V1 code path reads it. Skip unless the user is prepping for V2. |
| `META_PIXEL_ID` | Future auto-publisher (V2) | Same — no V1 code reads it. Skip. |

### What was removed (do not ask for these)

- `ANTHROPIC_API_KEY` — not needed. Claude Code itself is the intelligence layer.
- `OPENAI_API_KEY` — not needed. fal.ai hosts GPT Image 2, so FAL_KEY covers both models.

## How to get each key

- **`FAL_KEY`** — [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) → create API key
- **`META_ACCESS_TOKEN`** — Meta Business Manager → Business Settings → System Users → create or select a System User → **Generate New Token** with scopes `ads_read` (minimum for V1 reads) + `ads_management` + `business_management` (forward-compatible with V2 PUBLISHER). Set expiration to **Never** so the token is long-lived.
- **`META_AD_ACCOUNT_ID`** — format `act_1234567890`. Found in the Ads Manager URL (after `?act=`) or in Business Settings → Accounts → Ad accounts.

## Validation (what each test does)

| Key | Test hit | Success condition |
|---|---|---|
| `FAL_KEY` | `GET https://fal.run/health` with `Authorization: Key $FAL_KEY` | 200/404/405 (fal's gateway accepted the key) |
| `META_ACCESS_TOKEN` | `GET https://graph.facebook.com/v25.0/me` | 200 with `id` field |
| `META_AD_ACCOUNT_ID` | `GET https://graph.facebook.com/v25.0/$ACCOUNT_ID?fields=name,account_status,currency` | 200 with `account_status: 1` (ACTIVE) |

## Backing script

```bash
node scripts/config.js status                  # emit credential state (JSON, with tier + consumer)
node scripts/config.js set <KEY> <VALUE>       # validate against live API, save if it passes
node scripts/config.js test [<KEY>|all]        # re-validate without writing
node scripts/config.js help
```

## Standard flow in Claude Code

1. Run `node scripts/config.js status` — see what's set, what's missing, what failed last time. The output includes each key's `tier` (`required` or `deferred`) and `consumer` so you always know the V1 status.
2. Present the user a short summary grouped by tier: "Required (3): FAL_KEY, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID — need X of them. Deferred (2): skip."
3. For each **required** key that's missing, ask the user for the value.
4. Call `node scripts/config.js set <KEY> <VALUE>`. It only writes to `.env` if the live API test passes; otherwise it marks state `invalid` and returns Meta's verbatim error.
5. When all 3 required keys read `ok`, tell the user `npm start` (if not already running) and open `http://localhost:3000`.

## Hard rules

- Never print raw credential values in chat or logs. Always use the masked form from the script.
- Never ask for `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — they are not used.
- Never ask for `META_APP_ID` or `META_PIXEL_ID` unless the user explicitly brings them up — they are V2-deferred.
- Never call `set` without running `status` first — you might overwrite a working credential.
- Never write to `.env` directly (Edit/Write tools). `scripts/config.js` is the only path that validates before saving.
- If `set` fails, surface the verbatim error message from Meta/fal so the user can fix the credential.

## State file schema

```json
{
  "fal_key":            { "tier": "required", "consumer": "FORGE — image generation", "status": "ok", "last_tested": "2026-04-24T17:30:00Z", "masked_value": "••••••abcd", "meta": null, "error": null },
  "meta_access_token":  { "tier": "required", "consumer": "Overview tab", "status": "ok", "last_tested": "2026-04-24T17:30:01Z", "masked_value": "••••••WxYz", "meta": { "id": "1234", "name": "System User" }, "error": null },
  "meta_ad_account_id": { "tier": "required", "consumer": "Overview tab", "status": "ok", "last_tested": "2026-04-24T17:30:02Z", "masked_value": "act_••9012", "meta": { "name": "My Agency", "status": "ACTIVE", "currency": "USD" }, "error": null },
  "meta_app_id":        { "tier": "deferred", "consumer": "V2 PUBLISHER", "status": "missing", "last_tested": null, "masked_value": null, "meta": null, "error": null },
  "meta_pixel_id":      { "tier": "deferred", "consumer": "V2 PUBLISHER", "status": "missing", "last_tested": null, "masked_value": null, "meta": null, "error": null }
}
```

## Handoff

When the 3 required keys all read `ok`, CONFIG's job is done. The dashboard's Setup tab polls this file and shows each credential with a colored tier badge. Other skills (SCRAPER, RESEARCHER, FORGE) refuse to run if a key they need is missing.
