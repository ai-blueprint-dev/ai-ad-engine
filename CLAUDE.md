# AI Ad Engine — Project Context

Local-first, self-learning ad creative pipeline for Meta. Six Claude Code skills (`/config`, `/scraper`, `/researcher`, `/forge`, `/looper`, `/publisher`) drive the pipeline. An Express dashboard at `localhost:3000` reads the resulting state files.

See [README.md](README.md) for setup and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow.

## ⚠ First check at session start: skill discovery

The six pipeline skills live under `.claude/skills/`. Claude Code only auto-loads them at session start when its cwd is the project root. If the user launched Claude Code from a parent directory (e.g. an IDE workspace one level up), the skills won't be registered and `/scraper`, `/forge`, etc. won't autocomplete.

**Run this check before doing anything else:**

```bash
pwd
```

- Path ends in `ai-ad-engine` (or whatever this folder is named): skills are loaded, proceed normally.
- Path is *above* this folder: run the self-heal below.

### Self-heal procedure (parent-directory case)

Do this exactly once, then proceed normally. Don't lecture the user about cwd.

1. Identify the project subdirectory (the one containing this `CLAUDE.md` — typically `./ai-ad-engine`, but use whatever the user named it).
2. **Read each `<project>/.claude/skills/<name>/SKILL.md`** (six files: `config`, `scraper`, `researcher`, `forge`, `looper`, `publisher`). This triggers Claude Code's nested-skill discovery for the current session — the skills become invocable immediately.
3. **Persist for future sessions**: write/merge `{ "additionalDirectories": ["./<project>"] }` into `<cwd>/.claude/settings.json`. Create `<cwd>/.claude/` if missing. If `settings.json` already exists, parse it, append the project path to `additionalDirectories` (creating the array if absent, deduping if present), and write back — don't clobber existing fields.
4. Confirm with one line to the user: "Skills loaded — `/scraper`, `/forge`, etc. work now." That's it.

If `pwd` already ends in the project folder, do nothing — skills loaded automatically and the self-heal is unnecessary.

## Project conventions

- **All credential writes go through `scripts/config.js set <KEY> <VALUE>`** — it validates against live APIs before saving to `.env`. Never edit `.env` directly with `Edit`/`Write` tools.
- **All paid actions go through `scripts/forge.js`** — never call fal.ai from anywhere else in the codebase.
- **The dashboard (`server.js`) is read-only** — every state mutation is driven by a skill, never by an HTTP endpoint.
- **`state/` and `ads/pending/` are gitignored runtime artifacts** — never commit their contents.
- **Skills hand work off via files in `state/`**, not via direct invocation. SCRAPER writes a brief, RESEARCHER writes patterns, FORGE reads both. Keep that contract.

## Pipeline at a glance

```
SCRAPER → RESEARCHER → FORGE → (manual upload) → LOOPER → (back to FORGE)
   ↓          ↓          ↓                          ↓
 brief    patterns    creatives             winning_patterns
                                            losing_patterns
```

LOOPER never spends without explicit `/looper amplify <ad_id>` or `/looper rewrite <ad_id>`. SCRAPER and RESEARCHER are free. FORGE is ~$0.32/run on nano-banana-2, ~$0.88/run on gpt-image-2 (both via fal.ai).
