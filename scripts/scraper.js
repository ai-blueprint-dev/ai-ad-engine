#!/usr/bin/env node
/**
 * SCRAPER — product page → structured creative brief
 *
 * Three-tier fetch:
 *   1. Puppeteer (headless Chromium) — renders JS, gets the real DOM. Default for SPAs.
 *   2. Cheerio + plain HTTP fetch — fast, no JS, fallback if Puppeteer fails or --no-js is set.
 *   3. --paste mode — user describes the product manually, we build a brief from text.
 *      Used when both above fail (closed sites, captcha walls, fully client-rendered with no
 *      OG metadata) or when the user just wants to skip fetching.
 *
 * Usage:
 *   node scripts/scraper.js scrape <URL>                       full render → extract → save
 *   node scripts/scraper.js scrape <URL> --no-js               static HTML only (faster, fragile)
 *   node scripts/scraper.js paste <URL_or_id> --description '...' [--name '...'] [--hooks 'a;b;c']
 *   node scripts/scraper.js list / show / delete
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const BRIEFS_DIR = path.join(ROOT, 'state', 'briefs');
const ACTIVITY_LOG = path.join(ROOT, 'state', 'activity.jsonl');

function briefIdFromUrl(u) {
  const b64 = Buffer.from(u).toString('base64').replace(/[+/=]/g, '');
  return 'b_' + b64.slice(0, 12);
}

function logActivity(msg) {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: new Date().toISOString(), agent: 'SCRAPER', msg }) + '\n');
  } catch {}
}

// Tier 1: Puppeteer — renders JS so SPAs (React/Vue/Svelte) actually return content.
// Lazy-required so the script doesn't pay the Chromium spawn cost when --no-js is used.
async function fetchHtmlPuppeteer(url) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; AI-Ad-Engine/1.0; +https://ai-blueprint.local)');
    await page.setViewport({ width: 1280, height: 900 });
    // networkidle2 = wait until ≤2 connections for 500ms — handles most SPAs without hanging on long-poll.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    // Small grace period for any final React paints.
    await new Promise(r => setTimeout(r, 500));
    return await page.content();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Tier 2: plain HTTP fetch (the original V0 path). Fast, no JS — works on static sites.
async function fetchHtmlHttp(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AI-Ad-Engine/1.0; +https://ai-blueprint.local)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function scrape(url, opts = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const useJs = opts.useJs !== false;

  let html;
  let fetchMode;
  if (useJs) {
    logActivity(`Fetching ${url} with Puppeteer (JS-rendered)`);
    try {
      html = await fetchHtmlPuppeteer(url);
      fetchMode = 'puppeteer';
    } catch (e) {
      // Surface the puppeteer error to the user but try HTTP fallback before giving up.
      process.stderr.write(`Puppeteer failed (${e.message}) — falling back to plain HTTP fetch\n`);
      html = await fetchHtmlHttp(url);
      fetchMode = 'http-fallback';
    }
  } else {
    logActivity(`Fetching ${url} with plain HTTP (--no-js)`);
    html = await fetchHtmlHttp(url);
    fetchMode = 'http';
  }
  const $ = cheerio.load(html);

  const og = (prop) =>
    $(`meta[property="og:${prop}"]`).attr('content') ||
    $(`meta[name="og:${prop}"]`).attr('content');
  const metaC = (name) => $(`meta[name="${name}"]`).attr('content');

  const pageTitle = og('title') || $('title').first().text().trim() || '';
  const description = og('description') || metaC('description') || '';
  const image = og('image') || null;
  const siteName = og('site_name') || new URL(url).hostname;

  const h1 = $('h1').first().text().trim();
  const productName = (h1 || pageTitle.split(/[|—–-]/)[0]).trim().slice(0, 120);

  // Price heuristic
  let price = null;
  const priceCandidates = [
    $('[itemprop="price"]').attr('content'),
    $('[itemprop="price"]').first().text(),
    $('[class*="price"]').filter((_, el) => !/list-price|old-price|was/i.test($(el).attr('class') || '')).first().text(),
    $('[data-price]').attr('data-price'),
    $('[data-product-price]').attr('data-product-price'),
  ].filter(Boolean);
  for (const c of priceCandidates) {
    const m = String(c).replace(/\s+/g, ' ').match(/[\$£€¥₹]\s?\d[\d,.]{0,15}|\d[\d,.]{0,15}\s?(USD|EUR|GBP|JPY|CAD|AUD|INR)/i);
    if (m) { price = m[0].trim(); break; }
  }

  // Headlines
  const headlines = [];
  const seenHeadlines = new Set();
  $('h1, h2').slice(0, 8).each((_, el) => {
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    if (t && t.length < 120 && !seenHeadlines.has(t)) {
      headlines.push(t);
      seenHeadlines.add(t);
    }
  });

  // Copy hooks
  const hooks = [];
  const seenHooks = new Set();
  $('p, li, [class*="hero"] span, [class*="subtitle"]').each((_, el) => {
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    if (
      t.length >= 25 && t.length <= 180 &&
      !/cookie|privacy|terms of service|copyright|all rights reserved/i.test(t) &&
      !seenHooks.has(t)
    ) {
      hooks.push(t);
      seenHooks.add(t);
      if (hooks.length >= 15) return false;
    }
  });

  // Visual references (alt text)
  const visualRefs = [];
  const seenAlts = new Set();
  $('img').slice(0, 40).each((_, el) => {
    const alt = ($(el).attr('alt') || '').trim().replace(/\s+/g, ' ');
    if (alt && alt.length >= 10 && alt.length <= 200 && !seenAlts.has(alt)) {
      visualRefs.push(alt);
      seenAlts.add(alt);
    }
  });

  // Tone heuristic
  const sampleText = [pageTitle, description, ...hooks.slice(0, 8)].join(' ').toLowerCase();
  const toneSignals = [];
  if (/premium|luxury|exclusive|craft|handmade|hand-made|artisan/.test(sampleText)) toneSignals.push('premium');
  if (/fast|instant|quick|same-day|overnight|next-day/.test(sampleText)) toneSignals.push('fast');
  if (/eco|sustainable|green|natural|organic|recycled/.test(sampleText)) toneSignals.push('eco');
  if (/pro(?!duct|mo|gress)|professional|enterprise|performance/.test(sampleText)) toneSignals.push('pro');
  if (/fun|playful|bold|vibrant|colou?rful/.test(sampleText)) toneSignals.push('playful');
  if (/minimalist|simple|clean|essential/.test(sampleText)) toneSignals.push('minimal');

  const brief = {
    id: briefIdFromUrl(url),
    source_url: url,
    fetched_at: new Date().toISOString(),
    fetch_mode: fetchMode,
    site_name: siteName,
    product_name: productName || pageTitle || 'Untitled',
    price,
    image_url: image,
    description: description.slice(0, 600),
    headlines: headlines.slice(0, 10),
    hooks: hooks.slice(0, 12),
    visual_refs: visualRefs.slice(0, 12),
    tone: toneSignals.join(', ') || 'neutral',
  };

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const outPath = path.join(BRIEFS_DIR, `${brief.id}.json`);
  const existed = fs.existsSync(outPath);
  let previous = null;
  if (existed) {
    try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  }
  fs.writeFileSync(outPath, JSON.stringify(brief, null, 2));
  if (existed && previous) {
    brief._duplicate_of = {
      previously_fetched_at: previous.fetched_at,
      overwritten: true,
      note: 'This URL was already scraped. The brief has been updated with fresh data.',
    };
    logActivity(`Re-scraped ${url} — overwriting brief ${brief.id} (first fetched ${previous.fetched_at})`);
  } else {
    logActivity(`Saved brief ${brief.id} — ${brief.hooks.length} hooks, ${brief.headlines.length} headlines`);
  }
  return brief;
}

// Tier 3: --paste mode. The user (or Claude) describes the product in their own words. We build
// the same brief shape as scrape() but flagged so FORGE knows the source is human, not parsed HTML.
function cmdPaste(urlOrId, flags) {
  if (!urlOrId) throw new Error('Usage: paste <URL_or_id> --description "..." [--name "..."] [--hooks "a;b;c"] [--tone "premium,fast"]');
  const description = String(flags.description || '').trim();
  if (!description) throw new Error('--description is required (the actual product description in your own words)');
  if (description.length < 30) throw new Error('--description should be at least 30 chars — describe what the product does, who it\'s for, and what makes it different');

  // Allow a URL OR a synthetic id (e.g. "nexera"). If it's a URL, hash it the same way scrape() does
  // so re-running scrape later overwrites this paste-built brief.
  const isUrl = /^https?:\/\//i.test(urlOrId);
  const id = isUrl ? briefIdFromUrl(urlOrId) : 'b_paste_' + urlOrId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20);
  const url = isUrl ? urlOrId : `paste://${urlOrId}`;

  const productName = (flags.name || '').trim() || (isUrl ? new URL(urlOrId).hostname : urlOrId);
  const hooks = String(flags.hooks || '').split(';').map(s => s.trim()).filter(s => s.length >= 10);
  const headlines = String(flags.headlines || '').split(';').map(s => s.trim()).filter(s => s.length >= 4);
  const visualRefs = String(flags['visual-refs'] || '').split(';').map(s => s.trim()).filter(s => s.length >= 4);
  const tone = String(flags.tone || '').trim() || 'neutral';

  const brief = {
    id,
    source_url: url,
    fetched_at: new Date().toISOString(),
    fetch_mode: 'paste',
    site_name: isUrl ? new URL(urlOrId).hostname : '(human-described)',
    product_name: productName.slice(0, 120),
    price: flags.price || null,
    image_url: null,
    description: description.slice(0, 600),
    headlines: headlines.slice(0, 10),
    hooks: hooks.slice(0, 12),
    visual_refs: visualRefs.slice(0, 12),
    tone,
  };

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  fs.writeFileSync(path.join(BRIEFS_DIR, `${id}.json`), JSON.stringify(brief, null, 2));
  logActivity(`Paste-mode brief saved: ${id} — ${brief.hooks.length} hooks (described by user)`);
  process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
}

function cmdList() {
  if (!fs.existsSync(BRIEFS_DIR)) { process.stdout.write('[]\n'); return; }
  const files = fs.readdirSync(BRIEFS_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(BRIEFS_DIR, f), 'utf8'));
      return {
        id: b.id,
        product_name: b.product_name,
        source_url: b.source_url,
        fetched_at: b.fetched_at,
        hook_count: (b.hooks || []).length,
      };
    } catch { return null; }
  }).filter(Boolean);
  list.sort((a, b) => (b.fetched_at || '').localeCompare(a.fetched_at || ''));
  process.stdout.write(JSON.stringify(list, null, 2) + '\n');
}

function cmdShow(id) {
  if (!id) { process.stderr.write('Usage: scraper.js show <brief_id>\n'); process.exit(2); }
  const p = path.join(BRIEFS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) { process.stderr.write(`Not found: ${id}\n`); process.exit(1); }
  process.stdout.write(fs.readFileSync(p, 'utf8'));
}

function cmdDelete(id) {
  if (!id) { process.stderr.write('Usage: scraper.js delete <brief_id>\n'); process.exit(2); }
  const p = path.join(BRIEFS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) { process.stderr.write(`Not found: ${id}\n`); process.exit(1); }
  fs.unlinkSync(p);
  process.stdout.write(JSON.stringify({ ok: true, deleted: id }) + '\n');
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next != null && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function cmdHelp() {
  process.stdout.write(`SCRAPER — product page extractor (Puppeteer + Cheerio + paste fallback)

  Usage:
    node scripts/scraper.js scrape <URL>             render JS via Puppeteer, extract, save brief
    node scripts/scraper.js scrape <URL> --no-js     skip Puppeteer, plain HTML fetch only (faster, fragile)
    node scripts/scraper.js paste <URL_or_id> \\
       --description "..."                           required: actual product description (your words)
       [--name "Product Name"]                       optional: explicit product name
       [--hooks "hook1; hook2; hook3"]               optional: ;-separated copy hooks
       [--headlines "h1; h2"]                        optional: ;-separated headlines
       [--visual-refs "scene1; scene2"]              optional: ;-separated visual cues for FORGE
       [--tone "premium, fast"]                      optional: tone signals
       [--price "\$49"]                              optional
    node scripts/scraper.js list                     all saved briefs
    node scripts/scraper.js show <brief_id>          print one
    node scripts/scraper.js delete <brief_id>        remove

  When does each mode get used?
    scrape (default)   — works on most sites including SPAs (Nexera, modern React/Vue/Svelte)
    scrape --no-js     — for static HTML / when Puppeteer is unavailable / fast iteration on a static page
    paste              — when both fetch modes fail (closed sites, captcha walls) OR you want the brief to reflect
                         your actual product not whatever the page happens to say (e.g. stale OG metadata).
                         You describe; we build the same brief shape FORGE consumes.
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  try {
    switch (cmd) {
      case 'scrape': {
        if (!positional[0]) { process.stderr.write('Usage: scraper.js scrape <URL> [--no-js]\n'); process.exit(2); }
        const useJs = !flags['no-js'];
        const b = await scrape(positional[0], { useJs });
        process.stdout.write(JSON.stringify(b, null, 2) + '\n');
        break;
      }
      case 'paste': {
        cmdPaste(positional[0], flags);
        break;
      }
      case 'list':   cmdList(); break;
      case 'show':   cmdShow(positional[0]); break;
      case 'delete': cmdDelete(positional[0]); break;
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
