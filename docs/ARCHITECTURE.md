# Architecture

This document explains how the AI Ad Engine is organised, how data flows through it, where the intelligence lives, and how to extend it. For setup and quickstart, see the root [README](../README.md).

## Design principles

1. **Claude is the intelligence; scripts are storage.** Every skill spec instructs Claude to do the analysis (extract a brief, analyse a competitor ad, write image prompts, classify winners, view images via vision) and then call a small CLI script to persist the result. There is no separate LLM API key — Claude Code is the layer doing the work.
2. **Local-first.** Every artefact lives in your file system. The Express server only serves localhost. Nothing is uploaded except the explicit calls to Meta Marketing API and fal.ai.
3. **Data-driven, not opinion-driven.** Skills don't carry baked-in opinions about "what a good ad looks like." Aesthetic decisions in FORGE flow from the saved patterns the user provides via RESEARCHER (or describes via `user_described_style`). The skill spec explicitly forbids hard-coded composition recipes.
4. **Manual upload, no auto-publish.** V1 deliberately stops at `ads/pending/`. Auto-pushing to Meta would create a ban-wave attack surface. PUBLISHER is reserved for V2 with strict rate limits and approval gates.
5. **Single-process, single-user.** This is a CLI + dashboard tool meant to run on one machine for one operator. There's no auth, no multi-tenancy, no role separation.

## Component map

```
┌──────────────────────────────────────────────────────────────┐
│                    Claude Code (the "brain")                 │
│                                                              │
│  reads SKILL.md → does analysis → calls CLI scripts to save  │
└──────────────┬───────────────────────────────────────────────┘
               │ (Bash tool)
               ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│  scripts/*.js (storage)  │    │   server.js (read API)       │
│                          │    │                              │
│  scraper.js  → briefs/   │    │   /api/meta/ads              │
│  researcher.js → research│◄───┤   /api/research              │
│  forge.js  → ads/pending │    │   /api/looper/winners        │
│  looper.js → patterns    │    │   /api/looper/losers         │
│  config.js → .env        │    │   /api/creatives             │
└──────────────────────────┘    │   /api/creatives/image/:name │
                                │   /api/research/image/:id    │
                                │   /api/looper/playbook/:fn   │
                                └──────────────┬───────────────┘
                                               │
                                               ▼
                                ┌──────────────────────────────┐
                                │ dashboard.html (browser)     │
                                │  read-only viewer            │
                                └──────────────────────────────┘
                                               ▲
                                               │
                                ┌──────────────┴───────────────┐
                                │  External APIs (paid)        │
                                │   • Meta Marketing API v25   │
                                │   • fal.ai (nano-banana-2,   │
                                │     gpt-image-2, storage)    │
                                └──────────────────────────────┘
```

## Data flow

### A. Pre-launch (no live ad data yet)

```
SCRAPER          RESEARCHER             FORGE
   │                │                     │
   ▼                ▼                     ▼
state/briefs/   state/research.json   ads/pending/
                state/research/         (PNG + .meta.json)
                  images/
```

1. User runs `/scraper` with a product URL. Puppeteer renders the page (SPA-friendly), Cheerio extracts a brief, `briefs/{id}.json` is written.
2. User runs `/researcher` and either (a) drops a competitor screenshot file path, or (b) describes a style in their own words. Claude analyses both visual + text and saves to `research.json` with the screenshot copied to `research/images/`.
3. User runs `/forge`. Claude reads the brief + all saved patterns + any LOOPER winners, writes 4 image prompts where each prompt:
   - Maps to a specific brief hook
   - Mirrors a saved pattern's `format_type` distribution
   - Inherits aesthetic vocabulary from the pattern's `visual_analysis`
   - Includes the pattern's local image path in `reference_images`
4. `forge.js` resolves local paths via `fal.storage.upload()`, switches to the model's `/edit` endpoint when references are present, runs all variants in parallel via `Promise.all`, retries transient 5xx with exponential backoff, saves PNG + `.meta.json` sidecar with full provenance.
5. User downloads creatives from the dashboard's Creatives tab and uploads them to Meta Ads Manager themselves.

### B. Post-launch (live ad data flowing)

```
Meta Marketing API → server.js → dashboard       LOOPER (analyze)
                                                    │
                                                    ▼
                                             winning_patterns.json
                                             losing_patterns.json
                                                    │
                                  ┌─────────────────┼─────────────────┐
                                  ▼                                   ▼
                          looper amplify <id>                  looper rewrite <id>
                                  │                                   │
                                  ▼                                   ▼
                          forge.js (with refs)               forge.js (no refs)
                                  │                                   │
                                  ▼                                   ▼
                          ads/pending/                          ads/pending/
                          state/playbooks/                      state/playbooks/
                          {id}_{ts}.md                          {id}_rewrite_{ts}.md
```

1. Server's `/api/meta/ads` queries Meta Marketing API v25 (5-minute cache). The dashboard's Overview tab displays performance grouped by Campaign → Ad Set → Ad.
2. User runs `/looper`. Claude (or the user, via natural-language criteria) tunes the gates: `--metric` (cpl/leads/roas/ctr), `--min-spend` (default £50), `--min-days` (default 7), `--include-video` (default off — FORGE generates images only), etc.
3. `looper.js analyze` filters to eligible ads, computes the median score across them as the **benchmark**, classifies each into 🏆 winners (≥20% better than benchmark), ⚖ contenders, or ⚠ losers (≥50% worse, or zero conversions on substantial spend).
4. Claude views each winner's and loser's image (Claude's vision capability), writes structured analysis: `winning_elements` + `improvement_hypotheses` for winners; `failure_modes` + `change_hypotheses` for losers; `meta_settings` with explicit upload instructions.
5. The user runs `/looper amplify <ad_id>` for winners (FORGE with the winner image as reference) or `/looper rewrite <ad_id>` for losers (FORGE deliberately without reference, to avoid the failing approach). Each spawns FORGE internally; both produce a markdown playbook in `state/playbooks/`.

## File system contract

The scripts agree on these paths. Don't move them without coordinated changes.

| Path | Owner | What |
|---|---|---|
| `.env` | `config.js` | API keys (validated against live endpoints before write) |
| `state/briefs/{id}.json` | `scraper.js` | Product brief consumed by FORGE |
| `state/research.json` | `researcher.js` | Pattern library (3 source types: `competitor_ad`, `user_described_style`, `looper_winner`) |
| `state/research/images/{id}.{ext}` | `researcher.js` | Saved competitor ad screenshots |
| `state/winning_patterns.json` | `looper.js` | Top-N winners with Claude's enrichment |
| `state/losing_patterns.json` | `looper.js` | Top-N losers with Claude's enrichment |
| `state/playbooks/{id}_{ts}.md` | `looper.js` | Markdown upload guide per amplify/rewrite run |
| `state/activity.jsonl` | every script | Append-only event log streamed to dashboard's terminal pane |
| `state/tmp/` | `forge.js`, `looper.js` | Per-run prompt files passed to FORGE |
| `ads/pending/{id}.png` | `forge.js` | Generated creative |
| `ads/pending/{id}.meta.json` | `forge.js` | Sidecar with hook, prompt, model, brief_id, reference_images, amplifies (if from LOOPER) |

## The skills

Each skill is a `.claude/skills/<name>/SKILL.md` markdown file with YAML frontmatter (`name`, `description`, `color`, `icon`). When the user types `/skill-name` in Claude Code, the skill spec is loaded and Claude follows the instructions inside it. The skill specs are the authoritative source of behaviour — modify them to change how the engine works.

| Skill | Pipeline step | Output | Auto-chains to |
|---|---|---|---|
| `config` | 0 | `.env` | (manual: SCRAPER) |
| `scraper` | 1 | `state/briefs/{id}.json` | RESEARCHER (if user has competitor ads) → FORGE |
| `researcher` | 0.5 | `state/research.json` + `state/research/images/{id}.{ext}` | (back to current task) |
| `forge` | 2 | `ads/pending/*.png` | (manual upload, then later LOOPER) |
| `looper` | 4 | `state/winning_patterns.json`, `state/losing_patterns.json`, `state/playbooks/*.md` | self-invokes FORGE for amplify/rewrite |
| `publisher` | 3 | (V2 — not implemented) | — |

The auto-chain rules are in each skill's "Self-invocation & pipeline chaining" section. Claude consults these to decide whether to chain after completing a step.

## Pattern shape (the lingua franca)

`state/research.json` is an array of items with this shape. RESEARCHER writes them, FORGE reads them.

```json
{
  "id": "r_<base36>_<random>",
  "created_at": "ISO8601",
  "pattern_source": "competitor_ad" | "user_described_style" | "looper_winner",
  "advertiser": "...",
  "niche": "...",
  "headline": "...",
  "body": "...",
  "cta": "...",
  "source_url": "...",
  "image_path": "state/research/images/r_xxx.jpg" | null,
  "analysis": {
    "hooks": ["..."],
    "emotion": "...",
    "format": "...",
    "angle": "...",
    "cta_type": "...",
    "target_persona": "...",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "copyable_pattern": "..."
  },
  "visual_analysis": {
    "composition": "...",
    "color_palette": "...",
    "faces_present": true | false,
    "text_in_image": "...",
    "lighting": "...",
    "mood": "...",
    "format_type": "talking_head | before_after_split | product_on_white | graphic_typography | ...",
    "distinctive_elements": ["..."],
    "visual_pattern": "..."
  } | null
}
```

`winning_patterns.json` and `losing_patterns.json` follow a similar shape but with `category`, `score`, `criteria`, `benchmark`, `why`, `confidence` plus enrichment specific to winners (`winning_elements`, `improvement_hypotheses`, `meta_settings`) or losers (`failure_modes`, `change_hypotheses`, `rewrite_or_pause`, `meta_settings`). See `looper/SKILL.md` for the full schemas.

## How `/forge` actually generates an ad-shape image (not stock photo)

The single most important design decision in FORGE: it imposes no aesthetic opinions of its own. All composition, palette, faces, text-overlay decisions flow from saved patterns or explicit user instruction. This is what makes the loop genuinely self-learning — your competitive landscape decides what the engine produces, not the skill's hard-coded biases.

1. Read `state/research.json` and `state/winning_patterns.json`.
2. For each prompt, identify which saved pattern it structurally mirrors, and inherit:
   - `visual_analysis.format_type` → composition style
   - `visual_analysis.text_in_image` → whether to include text overlay
   - `visual_analysis.faces_present` → whether to include human faces
   - `visual_analysis.color_palette`, `lighting`, `mood`, `composition` → vocabulary used in the prompt
   - `visual_pattern` → structural template
   - `image_path` → attached as `reference_images` for fal.ai's `/edit` endpoint
3. The prompt text grounds the visual to a specific brief hook (a real claim about your product) — never generic.
4. `forge.js` switches to the model's `/edit` endpoint when references are present (`fal-ai/nano-banana-2/edit` or `openai/gpt-image-2/edit`), uploads local paths to `fal.storage`, runs N variants in parallel, retries on transient 5xx.

## Cost model

Two paid APIs:

| Service | Cost | Trigger |
|---|---|---|
| Meta Marketing API v25 | free under your existing Business plan | server background polling (5-min cache), every dashboard load |
| fal.ai nano-banana-2 | $0.08/image | every variant generated by `/forge` or `/looper amplify`/`/looper rewrite` |
| fal.ai gpt-image-2 | $0.22/image (high) | optional, only when user explicitly passes `--model gpt-image-2` |
| fal.ai storage | free for typical use | reference image uploads in `forge.js resolveRefs()` |

LOOPER's `analyze` step is **free** — only `amplify` and `rewrite` spend on fal.ai.

## Security model

- **Localhost-only.** `server.js` binds to `127.0.0.1`, rejects connections from other IPs, and 404s any path matching `/state/`, `/ads/`, `/scripts/`, `/.claude/`, `/.env`, `/.git/`, `/node_modules/`. Even if you expose port 3000, attackers can't read your patterns or credentials.
- **Path-traversal guards** on per-id endpoints (`/api/research/image/:id`, `/api/looper/playbook/:filename`) — id is strictly validated and resolved paths are checked to be inside the expected directory before serving.
- **Credentials never logged.** The `config.js` script masks values in its status output. Live keys exist only in `.env` (gitignored) and process memory.
- **No outbound network from `server.js`** except via `lib/meta.js` (Meta Marketing API) and the scripts spawned via `runScript`. Each script is sandboxed by its own process boundary.

## Extension points

If you want to extend or fork:

- **Add a new pipeline step.** Create `.claude/skills/<name>/SKILL.md` (frontmatter + flow), add `scripts/<name>.js` for storage, expose `/api/<name>/...` endpoints in `server.js`, add a Dashboard tab section.
- **Swap the image generator.** Both fal.ai models live in `scripts/forge.js` `MODELS` object. Adding a new provider is ~20 lines (endpoint, edit_endpoint, buildInput).
- **Change the looper scoring rule.** All scoring lives in `scripts/looper.js` `comparableScore()` and `classify()`. Replace either; the rest of the pipeline doesn't care how scoring works.
- **Add a new dashboard view.** The dashboard is a single HTML file with vanilla JS. Each tab is a `<div class="page page-X">`. The pattern is: server endpoint → fetch → render. No framework, no build step.
- **V2 PUBLISHER.** The skill spec at `.claude/skills/publisher/SKILL.md` documents what V2 should do. Implementation requires Meta Marketing API write scopes (`ads_management` + `ads:create`), strict rate limiting, and an approval gate so a runaway script can't burn budget.

## Known limitations and design tradeoffs

- **No multi-user support.** Single operator on a single machine. Adding auth/multi-tenancy is a large change.
- **No automatic upload to Meta.** V1 stops at `ads/pending/`. Adding auto-upload requires the V2 PUBLISHER skill plus operator approval workflow — see `publisher/SKILL.md`.
- **Activity log race condition** under heavy concurrent script invocations. In practice (single-user CLI), this hasn't surfaced. Could be hardened with a queued logger.
- **No budget cap** on fal.ai spend. The cost is predictable per-run ($0.32 / $0.88) but a malicious or buggy LOOPER amplify loop could theoretically rack up bills. Add a daily-spend gate in `forge.js` if this matters.
- **Puppeteer adds ~150MB to install.** Required for SPA scraping. The `--no-js` fallback exists for static sites if you want to drop the dependency.
