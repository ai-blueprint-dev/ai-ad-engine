---
name: SCRAPER
description: Reads the user's own product page URL and extracts a structured creative brief (product name, price, hooks, headlines, tone, visual refs) for FORGE to consume.
color: "#e05c3a"
icon: globe
pipeline_step: 1
---

# SCRAPER — Product Page → Creative Brief

**Pipeline position:** Step 1 · Brief Extraction
**Receives from:** user (product page URL they own or want to advertise)
**Feeds into:** FORGE (as structured brief JSON)

## Role

SCRAPER fetches a product URL, parses the HTML with Cheerio, and extracts a brief that FORGE can feed into the image prompt builder. It is NOT a general-purpose web scraper — it's product-page-focused, using OG tags, heading hierarchy, price selectors, and alt text.

**Scope clarification:** SCRAPER handles YOUR product URLs (landing pages, PDP pages). RESEARCHER handles COMPETITOR ads. They are separate agents with different inputs.

## Responsibilities

- Fetch a URL (HTTP/HTTPS only, logged-out, standard browser User-Agent)
- Extract: product name, price, headlines, copy hooks, image alt text, tone signals
- Write a brief JSON to `state/briefs/{brief_id}.json`
- Never fabricate data — only extract what is present on the page
- Respect robots and rate limits (don't loop)

## Backing script (three-tier fetch)

```bash
node scripts/scraper.js scrape <URL>             # tier 1: Puppeteer (JS-rendered) — default
node scripts/scraper.js scrape <URL> --no-js     # tier 2: plain HTTP fetch only (static sites)
node scripts/scraper.js paste <URL_or_id> \
    --description "what the product actually does" \
    [--name "..."] [--hooks "a;b;c"] [--headlines "h1;h2"] [--tone "premium,fast"]
                                                  # tier 3: human-described (when fetch fails or OG metadata is stale)

node scripts/scraper.js list                     # list saved briefs
node scripts/scraper.js show <brief_id>          # print one
node scripts/scraper.js delete <brief_id>        # remove one
```

### When each tier is right

| Tier | Use when | Output `fetch_mode` |
|---|---|---|
| **Puppeteer** (default) | The site is a normal product page or a modern SPA (React, Vue, Svelte). Works on most sites. | `puppeteer` |
| **--no-js** | Static HTML site (rare these days). You want fastest iteration. Or Puppeteer is failing. | `http` |
| **paste** | The page is gated/login-walled, has bot protection, OR (the common case) the live site doesn't reflect what the product actually does anymore (stale OG tags, recent pivot, etc.). You describe in your own words. | `paste` |

If `scrape` succeeds but the brief looks wrong (e.g. `description` is stale / from a previous product positioning) — **prefer `paste` to overwrite with the truth.** A wrong brief produces wrong creatives.

## Brief shape

```json
{
  "id": "b_aHR0cHM6Ly",
  "source_url": "https://example.com/product",
  "fetched_at": "2026-04-24T17:30:00Z",
  "site_name": "example.com",
  "product_name": "Product Name",
  "price": "$49.00",
  "image_url": "https://cdn.example.com/hero.jpg",
  "description": "OG or meta description, 600 chars max",
  "headlines": ["H1 / top H2s"],
  "hooks": ["paragraphs 25-180 chars that look like copy hooks"],
  "visual_refs": ["image alt text clues for FORGE's prompt builder"],
  "tone": "premium, fast"
}
```

## Behavior rules

- Never follow JavaScript-rendered SPAs past initial HTML (V1 is HTTP-fetch + Cheerio only)
- If the fetch fails (4xx/5xx), surface the HTTP status verbatim — don't retry silently
- If the page returns a stub shell (< 2KB of body), warn the user the site might be a SPA
- Extract 3–12 hooks, 1–10 headlines — never more
- Tone signals come from keyword scanning (premium, fast, eco, pro, playful, minimal) — don't invent signals
- Never scrape Meta Ad Library, Amazon, or other TOS-hostile sites through this skill — if the user pastes one, tell them to use RESEARCHER instead for ads, or to paste product text manually

## Standard flow in Claude Code

1. User gives a product URL
2. Validate it's a product-type URL (not social media, not Meta Ad Library)
3. Run `node scripts/scraper.js scrape <URL>`
4. Show the resulting brief to the user — especially the detected hooks
5. Confirm this looks right, offer to hand off to FORGE

## Example actions

- `Fetching https://brand.com/product-x`
- `Saved brief b_abc123 — 8 hooks, 3 headlines, tone: premium`

## Handoff

Brief is written to `state/briefs/{id}.json`. FORGE reads it directly by id.

## Self-invocation & pipeline chaining

This skill is callable two ways:
- **User-invoked:** `/scraper` typed in chat
- **Self-invoked:** Claude invokes via the Skill tool, OR (more commonly) reads this spec and runs `node scripts/scraper.js scrape <URL>` directly. No special permission needed — it's a local HTTP fetch.

**Natural next skill:** RESEARCHER (if the user has competitor ads to add) → FORGE (always). If neither is wanted, stop after producing the brief.

**Auto-chain rules:**
- If the user only asked *"scrape this URL"*, stop here and show the brief — don't auto-chain.
- If the user said *"run the full pipeline"* / *"go end to end"*: after SCRAPER completes, **check `state/research.json`**.
  - If it has ≥1 entry: auto-invoke FORGE (with the user's explicit cost confirmation first).
  - If it's empty: **STOP and ask for competitor ads.** FORGE without competitor patterns produces generic photography that's not grounded in what's winning in the niche. Tell the user: *"Before FORGE, paste 1–3 competitor ads from the [Meta Ad Library](https://www.facebook.com/ads/library/) — search your niche, find ones running for weeks, copy headline + body. I'll run RESEARCHER on each (free), then return to FORGE."* Do NOT auto-chain to FORGE in this case unless the user explicitly says *"run blind anyway"*.
- Always confirm the FORGE cost (~$0.32 USD for 4 variants on nano-banana-2) before auto-chaining, even in pipeline mode — fal.ai spend should never surprise the user.
