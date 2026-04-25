#!/usr/bin/env node
/**
 * RESEARCHER — competitor ad intelligence library (storage only)
 *
 * Pure CRUD over state/research.json. No AI calls. Claude Code does the
 * analysis (TEXT + VISUAL) inline when the user invokes the RESEARCHER skill,
 * then hands the fully-analyzed item to this script via `save`.
 *
 * Image ads: the user drops a screenshot into Claude Code, Claude views it
 * with its vision capability, and adds a `visual_analysis` block to the
 * payload. If `image_path` is provided in the JSON, this script copies the
 * file into state/research/images/{id}.png so the dashboard can display it.
 *
 * Usage:
 *   node scripts/researcher.js save '<json>'    # persist an analyzed item (text + optional visual)
 *   node scripts/researcher.js list             # all items (JSON)
 *   node scripts/researcher.js show <id>        # one item
 *   node scripts/researcher.js delete <id>      # remove
 *   node scripts/researcher.js stats            # { count, last_at }
 *
 * Item shape (produced by Claude in the skill, handed to `save`):
 *   {
 *     advertiser, niche, headline, body, cta, source_url,
 *     image_path,                            // optional — local path to screenshot, gets copied
 *     analysis: { hooks, emotion, format, angle, cta_type,
 *                 target_persona, strengths, weaknesses, copyable_pattern },
 *     visual_analysis: {                     // optional — present when image was provided
 *       composition, color_palette, faces_present, text_in_image,
 *       lighting, mood, format_type, distinctive_elements,
 *       visual_pattern                        // de-branded structural template for FORGE
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'state', 'research.json');
const IMAGES_DIR = path.join(ROOT, 'state', 'research', 'images');
const ACTIVITY_LOG = path.join(ROOT, 'state', 'activity.jsonl');

function loadLibrary() {
  if (!fs.existsSync(STATE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return []; }
}

function saveLibrary(items) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(items, null, 2));
}

function logActivity(msg) {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: new Date().toISOString(), agent: 'RESEARCHER', msg }) + '\n');
  } catch {}
}

function genId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Copy a screenshot into state/research/images/{id}.{ext} so the dashboard can show it.
// Returns the relative path to store on the item, or null if nothing was copied.
function persistImage(srcPath, id) {
  if (!srcPath) return null;
  const abs = path.isAbsolute(srcPath) ? srcPath : path.resolve(ROOT, srcPath);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`warn: image_path not found, skipping copy: ${srcPath}\n`);
    return null;
  }
  const ext = (path.extname(abs).toLowerCase().match(/\.(png|jpg|jpeg|webp|gif)$/) || ['.png'])[0];
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const dest = path.join(IMAGES_DIR, `${id}${ext}`);
  fs.copyFileSync(abs, dest);
  return `state/research/images/${id}${ext}`;
}

function normalize(item) {
  const a = item.analysis || {};
  const v = item.visual_analysis || null;
  const id = item.id || genId();
  // Persist the image first so we have its stored path on the item.
  const stored_image_path = persistImage(item.image_path, id);
  // pattern_source distinguishes how this entry came into the library. FORGE reads it to know
  // how much to weight a pattern (looper_winner > competitor_ad > user_described_style).
  const validSources = ['competitor_ad', 'user_described_style', 'looper_winner'];
  const pattern_source = validSources.includes(item.pattern_source) ? item.pattern_source : 'competitor_ad';
  return {
    id,
    created_at: item.created_at || new Date().toISOString(),
    pattern_source,
    advertiser: String(item.advertiser || '').trim(),
    niche: String(item.niche || '').trim(),
    headline: String(item.headline || '').trim(),
    body: String(item.body || '').trim(),
    cta: String(item.cta || '').trim(),
    source_url: String(item.source_url || '').trim(),
    image_path: stored_image_path,
    analysis: {
      hooks:            Array.isArray(a.hooks) ? a.hooks.slice(0, 6) : [],
      emotion:          String(a.emotion || '').trim(),
      format:           String(a.format || '').trim(),
      angle:            String(a.angle || '').trim(),
      cta_type:         String(a.cta_type || '').trim(),
      target_persona:   String(a.target_persona || '').trim(),
      strengths:        Array.isArray(a.strengths)  ? a.strengths.slice(0, 5)  : [],
      weaknesses:       Array.isArray(a.weaknesses) ? a.weaknesses.slice(0, 5) : [],
      copyable_pattern: String(a.copyable_pattern || '').trim(),
    },
    visual_analysis: v ? {
      composition:           String(v.composition || '').trim(),
      color_palette:         String(v.color_palette || '').trim(),
      faces_present:         !!v.faces_present,
      text_in_image:         String(v.text_in_image || '').trim(),
      lighting:              String(v.lighting || '').trim(),
      mood:                  String(v.mood || '').trim(),
      format_type:           String(v.format_type || '').trim(),
      distinctive_elements:  Array.isArray(v.distinctive_elements) ? v.distinctive_elements.slice(0, 8) : [],
      visual_pattern:        String(v.visual_pattern || '').trim(),
    } : null,
  };
}

function cmdSave(payloadJson) {
  let raw;
  try { raw = JSON.parse(payloadJson); }
  catch { throw new Error('First arg must be a JSON payload'); }

  // Allow text-only OR image-only OR both — OR a user_described_style with just niche+body+visual_analysis.
  const hasText = !!(raw.headline || raw.body);
  const hasImage = !!raw.image_path;
  const isUserDescribed = raw.pattern_source === 'user_described_style';
  if (!hasText && !hasImage && !isUserDescribed) {
    throw new Error('Need at least one of: "headline", "body", "image_path", or pattern_source="user_described_style"');
  }
  if (!raw.analysis || typeof raw.analysis !== 'object') {
    throw new Error('Need an "analysis" object — Claude Code should produce this before calling save');
  }
  // If an image was provided, visual_analysis is required (Claude looked at it, must report).
  if (hasImage && !raw.visual_analysis) {
    throw new Error('image_path provided but no visual_analysis — Claude must view the image and add the visual_analysis block');
  }
  // user_described_style requires niche + body + visual_analysis (the description has to specify a style).
  if (isUserDescribed) {
    if (!raw.niche) throw new Error('user_described_style requires "niche"');
    if (!raw.body) throw new Error('user_described_style requires "body" (the user\'s verbatim style description)');
    if (!raw.visual_analysis) throw new Error('user_described_style requires "visual_analysis" with at least format_type, mood, and visual_pattern');
  }

  const item = normalize(raw);
  const lib = loadLibrary();
  lib.unshift(item);
  saveLibrary(lib);
  const visualNote = item.visual_analysis ? ` · visual: ${item.visual_analysis.format_type || 'analyzed'}` : '';
  logActivity(`Saved ${item.id} — ${item.advertiser || 'unknown'} · hooks: ${(item.analysis.hooks || []).slice(0, 3).join(', ')}${visualNote}`);
  process.stdout.write(JSON.stringify(item, null, 2) + '\n');
}

function cmdList() { process.stdout.write(JSON.stringify(loadLibrary(), null, 2) + '\n'); }

function cmdShow(id) {
  if (!id) { process.stderr.write('Usage: researcher.js show <id>\n'); process.exit(2); }
  const it = loadLibrary().find(x => x.id === id);
  if (!it) { process.stderr.write(`Not found: ${id}\n`); process.exit(1); }
  process.stdout.write(JSON.stringify(it, null, 2) + '\n');
}

function cmdDelete(id) {
  if (!id) { process.stderr.write('Usage: researcher.js delete <id>\n'); process.exit(2); }
  const lib = loadLibrary();
  const target = lib.find(x => x.id === id);
  const next = lib.filter(x => x.id !== id);
  if (next.length === lib.length) { process.stderr.write(`Not found: ${id}\n`); process.exit(1); }
  saveLibrary(next);
  // Best-effort cleanup of the stored screenshot (don't fail the delete if image is missing).
  if (target?.image_path) {
    try {
      const abs = path.resolve(ROOT, target.image_path);
      if (abs.startsWith(IMAGES_DIR) && fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {}
  }
  logActivity(`Deleted ${id}`);
  process.stdout.write(JSON.stringify({ ok: true, deleted: id, remaining: next.length }) + '\n');
}

function cmdStats() {
  const lib = loadLibrary();
  process.stdout.write(JSON.stringify({
    count: lib.length,
    last_at: lib[0]?.created_at || null,
  }) + '\n');
}

function cmdHelp() {
  process.stdout.write(`RESEARCHER — competitor ad intelligence (storage only)

  Usage:
    node scripts/researcher.js save '<json>'   persist an analyzed item
    node scripts/researcher.js list            list all saved (JSON)
    node scripts/researcher.js show <id>       print one
    node scripts/researcher.js delete <id>     remove one
    node scripts/researcher.js stats           { count, last_at }

  Intelligence happens in Claude Code. This script is pure storage —
  Claude produces the "analysis" object, then calls \`save\`.
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'save':   cmdSave(args[0] || '{}'); break;
      case 'list':   cmdList(); break;
      case 'show':   cmdShow(args[0]); break;
      case 'delete': cmdDelete(args[0]); break;
      case 'stats':  cmdStats(); break;
      case 'help':
      case '--help':
      case '-h':
      case undefined: cmdHelp(); break;
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        cmdHelp();
        process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();
