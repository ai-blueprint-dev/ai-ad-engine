# AI Ad Engine

A **local-first, self-learning creative pipeline** for Meta ads. Built around five Claude Code skills that scrape your product page, analyse competitor ads, generate fresh creatives via fal.ai, monitor what's actually winning in your live Meta account, and amplify the winners into new variants.

The intelligence is Claude. The persistence is local files. Nothing leaves your machine except the API calls you explicitly trigger (Meta Marketing API, fal.ai).

```
SCRAPER → RESEARCHER → FORGE → (manual upload) → LOOPER → (back to FORGE)
   |          |          |                          |
   ↓          ↓          ↓                          ↓
 brief    patterns    creatives                 winning_patterns
                                                losing_patterns
```

## What it actually does

- **`/scraper`** — fetch a product URL (Puppeteer renders SPAs), extract a brief.
- **`/researcher`** — drop a competitor ad screenshot into chat. Claude views the image, analyses both the visual pattern (composition, palette, faces, text-overlay) AND the text copy (hooks, emotion, angle), saves both with the screenshot stored locally.
- **`/forge`** — Claude writes ad-shape image prompts grounded in your saved patterns + brief, attaches the saved pattern images as **fal.ai reference images** so generated variants stay structurally on-brand. Renders 4 variants in parallel via fal.ai (~$0.32/run on nano-banana-2, ~$0.88 on gpt-image-2).
- **`/looper`** — reads your live Meta performance, applies confidence gates (min spend, min days running, image-only), classifies every ad into 🏆 **winners** / ⚖ **contenders** / ⚠ **losers** against an account benchmark. Claude views each winner and loser image and writes structured analysis. `looper amplify <ad_id>` then runs FORGE with the winner image as a fal.ai reference. `looper rewrite <ad_id>` runs FORGE without a reference (deliberately avoiding the loser's approach). Each run produces a markdown **playbook** with step-by-step Meta Ads Manager upload instructions.
- **`/config`** — set up your three credentials (Meta access token, Meta ad account, fal.ai key) and validate them against live endpoints.

A dashboard at `http://localhost:3000` reads everything: live Meta performance grouped by campaign → ad set → ad, a chart of daily performance, your saved patterns, generated creatives, and the looper buckets. The dashboard is read-only — every action is driven from Claude Code.

## Prerequisites

| | Required | How to verify |
|---|---|---|
| Claude Code | yes | `claude --version` |
| Node.js | ≥ 20.0.0 | `node --version` |
| Meta Business Manager System User token | yes (for live data) | scopes: `ads_read` + `ads_management` + `business_management` + `pages_read_engagement`; expiration: never |
| Meta Ad Account ID | yes | format `act_1234567890`, find it in your Ads Manager URL |
| fal.ai API key | yes (for FORGE) | from [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |

You don't need an Anthropic API key — Claude Code is the intelligence layer. You don't need an OpenAI key — fal.ai hosts both Nano Banana 2 and GPT Image 2 through one credential.

## Setup

```bash
# 1. clone + install
git clone <this-repo>
cd ai-ad-engine
npm install                    # also installs Puppeteer's bundled Chromium (~150MB)

# 2. start the dashboard server (localhost-only)
npm start                      # http://localhost:3000

# 3. set your credentials via Claude Code (validates against live APIs before saving)
#    in a separate terminal, in the same directory, open Claude Code and:
/config                        # walks you through the 3 keys
```

The `/config` skill prompts you for each credential and validates it against the live API before writing to `.env`. If a key is wrong, it surfaces Meta or fal's error verbatim so you can fix it.

## First-run pipeline

```
# In Claude Code, with the dashboard server running:

/scraper                       # paste your product URL → brief saved
/researcher                    # save 2-3 competitor ads from Meta Ad Library
                               #   (right-click ad image → Save image as…, then drop the file path in chat)
/forge                         # 4 grounded variants land in ads/pending/ (~$0.32 USD)
                               #   review them in the Creatives tab, download what you like

# upload manually to Meta Ads Manager — V1 doesn't auto-publish (no ban-wave risk)

# wait 7+ days, ≥£50 spend per ad — Meta's learning phase exits

/looper                        # analyses live performance, classifies winners/losers
                               #   Claude views each one, writes structured analysis
/looper amplify <ad_id>        # 4 winner variants with the original as fal.ai reference (~$0.32)
/looper rewrite <ad_id>        # 4 alternatives that explicitly avoid the loser's approach
                               # → state/playbooks/<id>_<ts>.md tells you how to upload
```

## Project structure

```
.
├── server.js              Express server (localhost-only, blocks /state /ads /scripts /.claude /.env paths)
├── dashboard.html         Single-page dashboard (no build step, vanilla JS)
├── lib/
│   └── meta.js            Meta Marketing API v25 client + insights parsing
├── scripts/
│   ├── config.js          Set / validate credentials (writes .env)
│   ├── scraper.js         Product page → brief (Puppeteer with HTTP fallback + paste mode)
│   ├── researcher.js      Save competitor ad analysis (text + image + visual analysis)
│   ├── forge.js           Render image prompts via fal.ai (parallel, retries, reference-image upload)
│   └── looper.js          Read live perf → classify → enrich → amplify/rewrite via FORGE
├── .claude/skills/        Skill specs (markdown) — config, scraper, researcher, forge, looper, publisher
├── ads/pending/           Generated creatives (PNG + .meta.json sidecars) — gitignored
├── state/
│   ├── briefs/            Saved briefs from SCRAPER (gitignored)
│   ├── research.json      Competitor + user-described patterns from RESEARCHER (gitignored)
│   ├── research/images/   Saved competitor ad screenshots (gitignored)
│   ├── winning_patterns.json  / losing_patterns.json  (LOOPER, gitignored)
│   ├── playbooks/         Markdown playbooks from LOOPER amplify/rewrite (gitignored)
│   └── activity.jsonl     Append-only agent activity log (gitignored)
└── docs/
    └── ARCHITECTURE.md    Detailed architecture + data flow + extension points
```

## Cost model

Everything is local except two paid APIs:
- **Meta Marketing API** — read-only access. Free under your existing Meta Business plan.
- **fal.ai image generation** — pay per image. Default is nano-banana-2 at **$0.08/image** (~$0.32 per 4-variant FORGE run). Switch to gpt-image-2 at **$0.22/image** for sharper text rendering (~$0.88/run).

LOOPER never spends without your explicit `amplify` or `rewrite` command. SCRAPER and RESEARCHER are free.

## Why local-first?

- **No SaaS subscription, no platform lock-in.** Your data, your patterns, your generated creatives all live in your file system.
- **No "auto-publish to Meta" in V1.** The risk of a runaway script ban-waving an ad account is too high. You upload manually until V2 ships PUBLISHER.
- **No third-party intelligence layer.** Claude Code (which you already pay for) is the brain. No separate Anthropic key, no separate OpenAI key, no analyst dashboard service.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard tab shows "Overview needs Meta credentials" | `.env` missing or `META_ACCESS_TOKEN` invalid | run `/config` to re-validate |
| `/api/meta/ads` returns 502 with `(#100) Tried accessing nonexisting field` | older Meta SDK or API drift | check `lib/meta.js` insight field list against [Meta API v25 docs](https://developers.facebook.com/docs/marketing-api/reference/ads-insights/) |
| FORGE images look like generic stock photos | running blind (no patterns saved) | save 2–3 patterns via `/researcher` before re-running `/forge` |
| FORGE 500 error from fal.ai | transient cluster issue | the script auto-retries up to 3× with backoff; if all fail, retry the command |
| Reference image thumbnail in Creatives detail panel won't load | older builds linked direct file paths to `/state/...` (blocked by security middleware) | already fixed — paths are now routed through `/api/research/image/:id` |
| LOOPER says "no winners" | not enough spend or too-recent ads | lower `--min-spend` or `--min-days`, or wait for more spend to accrue |
| `/scraper` returns empty hooks for a real product page | site is JS-rendered (SPA) and Puppeteer mode failed | the script auto-falls-back to plain HTTP fetch; if that's empty too, use `paste` mode with your own description |
| Puppeteer install hangs on `npm install` | Chromium download (~150MB) on slow connection | be patient, or set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` and rely on system Chrome |

For deeper architecture and extension points, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT — see [LICENSE](LICENSE).

The skill specs in `.claude/skills/` are also MIT and explicitly designed to be modified to fit your workflow.
