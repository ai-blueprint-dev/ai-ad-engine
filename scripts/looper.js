#!/usr/bin/env node
/**
 * LOOPER — V1 self-learning feedback loop (winners + contenders + losers)
 *
 * Reads live performance, computes an account-level benchmark on the chosen metric, classifies
 * every eligible ad into three buckets, and asks Claude to enrich each meaningfully:
 *
 *   🏆 WINNERS    — pass gates, beat the benchmark by ≥winner_margin (default 20%)
 *                  → enrich with winning_elements + improvement_hypotheses
 *                  → amplify generates targeted variants
 *   ⚖ CONTENDERS  — pass gates but don't yet beat the benchmark
 *                  → no enrichment / no action — wait for more data
 *   ⚠ LOSERS      — pass gates AND (zero conversions OR ≥loser_margin worse than benchmark)
 *                  → enrich with failure_modes + change_hypotheses
 *                  → rewrite generates alternatives that AVOID the loser's approach
 *
 * The intelligence is in the SKILL flow (Claude analyzing each image and writing structured
 * fields). This script enforces structural gates: it REFUSES amplify/rewrite without enrichment.
 *
 * Defaults (research-backed; see SKILL.md):
 *   min_spend = £50  · min_days = 7  · image-only · top = 3
 *   winner_margin = 20% better than median   ·   loser_margin = 50% worse than median
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const WINNERS_FILE = path.join(STATE, 'winning_patterns.json');
const LOSERS_FILE = path.join(STATE, 'losing_patterns.json');
const ACTIVITY_LOG = path.join(STATE, 'activity.jsonl');
const BRIEFS_DIR = path.join(STATE, 'briefs');
const TMP_DIR = path.join(STATE, 'tmp');
const PLAYBOOKS_DIR = path.join(STATE, 'playbooks');
const SERVER_BASE = process.env.LOOPER_SERVER_BASE || 'http://localhost:3000';

// ============ Helpers ============

function logActivity(msg) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: new Date().toISOString(), agent: 'LOOPER', msg }) + '\n');
  } catch {}
}

function readPatterns(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; }
  catch { return []; }
}
function writePatterns(file, arr) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next != null && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

function fmtMoney(n) {
  return '£' + (Math.round(n * 100) / 100).toFixed(2);
}

function median(numbers) {
  const sorted = numbers.slice().filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ============ Scoring ============

const METRIC_DEFAULT_DIRECTION = {
  cpl: 'asc', cpc: 'asc', cpm: 'asc',
  leads: 'desc', roas: 'desc', ctr: 'desc', reach: 'desc', spend: 'desc', impressions: 'desc',
};

function getMetricValue(ad, metric) {
  switch (metric) {
    case 'cpl':         return ad.leads > 0 ? ad.cpl : Infinity;
    case 'cpc':         return ad.cpc || Infinity;
    case 'cpm':         return ad.cpm || Infinity;
    case 'leads':       return ad.leads || 0;
    case 'roas':        return ad.roas || 0;
    case 'ctr':         return ad.link_ctr || ad.ctr || 0;
    case 'reach':       return ad.reach || 0;
    case 'spend':       return ad.spend || 0;
    case 'impressions': return ad.impressions || 0;
    default:            return 0;
  }
}

// Higher score is "better" only after we've factored in direction. This returns a comparable
// number where higher = better, regardless of metric direction. Used for benchmark comparisons
// and bucket classification. asc metrics (CPL, CPC, CPM) get inverted via 1/x; desc stays.
function comparableScore(ad, metric, direction) {
  const v = getMetricValue(ad, metric);
  if (!Number.isFinite(v)) return 0;
  if (direction === 'asc') {
    if (v <= 0) return 0;
    return 1 / v;
  }
  return v;
}

// Classify against the benchmark. Returns 'winner' | 'contender' | 'loser'.
//   winner  = score better than benchmark by winner_margin %
//   loser   = score worse than benchmark by loser_margin %, OR zero conversions on substantial spend
//   contender = anything in between
function classify(ad, score, benchmark, criteria) {
  // Fast-path: zero leads and well over the spend floor → loser regardless of margin math
  if (criteria.metric === 'cpl' && (ad.leads || 0) === 0 && (ad.spend || 0) >= criteria.min_spend) {
    return 'loser';
  }
  if (benchmark === null || benchmark === 0) return 'contender'; // no benchmark = nothing to compare against
  const ratio = score / benchmark;
  // For asc metrics (lower=better), comparableScore inverts so a winner has HIGHER comparable score.
  // Hence: winner if ratio > 1 + margin/100, loser if ratio < 1 - loser_margin/100.
  if (ratio >= 1 + criteria.winner_margin / 100) return 'winner';
  if (ratio <= 1 - criteria.loser_margin / 100) return 'loser';
  return 'contender';
}

// Build a human-readable explanation of WHY this ad landed in this bucket. This is what the
// dashboard shows verbatim and what the skill flow surfaces to the user.
function whyExplanation(category, ad, score, benchmark, criteria) {
  const metric = criteria.metric;
  const metricLabel = metric.toUpperCase();
  const fmtMetric = (v) => {
    if (!Number.isFinite(v)) return '—';
    if (metric === 'cpl' || metric === 'cpc' || metric === 'cpm') return fmtMoney(v);
    if (metric === 'roas') return v.toFixed(2) + 'x';
    if (metric === 'ctr') return v.toFixed(2) + '%';
    return Math.round(v).toLocaleString();
  };
  const adValue = getMetricValue(ad, metric);
  const adValueStr = fmtMetric(adValue);
  const benchStr = benchmark != null ? fmtMetric(criteria.direction === 'asc' ? 1 / benchmark : benchmark) : 'no benchmark';

  if (category === 'winner') {
    const pctBetter = Math.round((score / benchmark - 1) * 100);
    return `${adValueStr} ${metricLabel} — ${pctBetter}% better than your account benchmark of ${benchStr}.`;
  }
  if (category === 'loser') {
    if (criteria.metric === 'cpl' && (ad.leads || 0) === 0) {
      return `${fmtMoney(ad.spend || 0)} spent, 0 leads. Past the ${criteria.min_days}d / ${fmtMoney(criteria.min_spend)} confidence floor — this isn't bad luck, it's a real loser.`;
    }
    const pctWorse = Math.round((1 - score / benchmark) * 100);
    return `${adValueStr} ${metricLabel} — ${pctWorse}% worse than your account benchmark of ${benchStr}. Time to rewrite or pause.`;
  }
  // contender
  if (benchmark === null) {
    return `${adValueStr} ${metricLabel}. Only data point in this batch — keep spending so we can compare against a real benchmark.`;
  }
  const closeness = Math.abs(Math.round((score / benchmark - 1) * 100));
  return `${adValueStr} ${metricLabel} — within ${closeness}% of your benchmark (${benchStr}). Keep running, will categorise on the next analyze.`;
}

// ============ Live data fetch ============

async function fetchLiveAds(range) {
  const url = `${SERVER_BASE}/api/meta/ads?range=${encodeURIComponent(range)}`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(`server ${r.status}: ${body.error || 'request failed'} — is npm start running?`);
  }
  const body = await r.json();
  if (body.mode !== 'live') throw new Error(`server returned mode=${body.mode} (need live Meta data — check /config)`);
  return body.ads || [];
}

function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
}

function evaluateEligibility(ad, criteria) {
  const reasons = [];
  if (!criteria.include_video && ad.is_video) reasons.push('video (FORGE generates images only)');
  if ((ad.spend || 0) < criteria.min_spend) reasons.push(`spend ${fmtMoney(ad.spend || 0)} < ${fmtMoney(criteria.min_spend)} floor`);
  const days = daysSince(ad.created_time);
  if (days !== null && days < criteria.min_days) reasons.push(`only ${days}d old, < ${criteria.min_days}d floor`);
  if (ad.status === 'learning') reasons.push('still in Meta learning phase');
  return { eligible: reasons.length === 0, reasons, days_running: days };
}

// Skeleton for a WINNER pattern. Claude enriches *_TODO fields via `looper.js save`.
function winnerSkeleton(ad, criteria, score, benchmark, days_running, why) {
  return {
    category: 'winner',
    source_ad_id: ad.id, source_ad_name: ad.name,
    source_campaign: ad.campaign_name, source_adset: ad.adset_name,
    source_adset_optimization_goal: ad.adset_optimization_goal,
    score: Math.round(score * 1000) / 1000,
    score_metric: criteria.metric,
    score_direction: criteria.direction,
    benchmark: benchmark != null ? Math.round(benchmark * 1000) / 1000 : null,
    why,
    criteria,
    metrics: extractMetrics(ad),
    days_running,
    creative_format: ad.is_video ? 'video' : 'image',
    thumb_url: ad.thumb_url, video_id: ad.video_id || null,
    headline: ad.headline || '', objective: ad.obj || '',

    confidence: null, hook: null, copyable_pattern: null, visual_notes: null,
    winning_elements: null, improvement_hypotheses: null, meta_settings: null, brief_addendum: null,

    captured_at: new Date().toISOString(),
    enriched_at: null,
    amplified_runs: [],
  };
}

// Skeleton for a LOSER pattern. Note the different enrichment fields — failure_modes (what's
// not working) and change_hypotheses (what to try instead) are the loser equivalents of
// winning_elements / improvement_hypotheses.
function loserSkeleton(ad, criteria, score, benchmark, days_running, why) {
  return {
    category: 'loser',
    source_ad_id: ad.id, source_ad_name: ad.name,
    source_campaign: ad.campaign_name, source_adset: ad.adset_name,
    source_adset_optimization_goal: ad.adset_optimization_goal,
    score: Math.round(score * 1000) / 1000,
    score_metric: criteria.metric,
    score_direction: criteria.direction,
    benchmark: benchmark != null ? Math.round(benchmark * 1000) / 1000 : null,
    why,
    criteria,
    metrics: extractMetrics(ad),
    days_running,
    creative_format: ad.is_video ? 'video' : 'image',
    thumb_url: ad.thumb_url, video_id: ad.video_id || null,
    headline: ad.headline || '', objective: ad.obj || '',

    confidence: null, hook_observed: null, visual_notes: null,
    failure_modes: null, change_hypotheses: null,
    rewrite_or_pause: null,                 // 'rewrite' | 'pause'
    rewrite_brief_addendum: null,           // free-form direction for new prompts
    meta_settings: null,                    // upload settings for the rewrite (or null if pause)

    captured_at: new Date().toISOString(),
    enriched_at: null,
    rewrite_runs: [],
  };
}

function extractMetrics(ad) {
  return {
    spend: ad.spend, leads: ad.leads, cpl: ad.cpl,
    roas: ad.roas, conv: ad.conv,
    ctr: ad.ctr, link_ctr: ad.link_ctr,
    impressions: ad.impressions, reach: ad.reach,
    cpm: ad.cpm, cpc: ad.cpc,
  };
}

// ============ Commands ============

async function cmdAnalyze(flags) {
  const range = flags.range || '180d';
  const metric = (flags.metric || 'cpl').toLowerCase();
  if (!METRIC_DEFAULT_DIRECTION[metric]) {
    throw new Error(`unknown metric "${metric}". Valid: ${Object.keys(METRIC_DEFAULT_DIRECTION).join(', ')}`);
  }
  const direction = (flags.direction || METRIC_DEFAULT_DIRECTION[metric]).toLowerCase();
  if (direction !== 'asc' && direction !== 'desc') throw new Error(`--direction must be asc|desc`);

  const criteria = {
    metric, direction,
    min_spend: parseFloat(flags['min-spend'] != null ? flags['min-spend'] : 50),
    min_days: parseInt(flags['min-days'] != null ? flags['min-days'] : 7, 10),
    include_video: !!flags['include-video'],
    range,
    top: parseInt(flags.top || '3', 10),
    winner_margin: parseFloat(flags['winner-margin'] != null ? flags['winner-margin'] : 20),
    loser_margin: parseFloat(flags['loser-margin'] != null ? flags['loser-margin'] : 50),
    benchmark_override: flags.benchmark != null ? parseFloat(flags.benchmark) : null,
  };

  const ads = await fetchLiveAds(range);

  // Eligibility pass.
  const tagged = ads.map(ad => ({ ad, ...evaluateEligibility(ad, criteria) }));
  const eligible = tagged.filter(t => t.eligible);
  const rejected = tagged.filter(t => !t.eligible);

  // Score eligible ads. comparableScore is the apples-to-apples number — higher = better
  // regardless of metric direction. We use it for benchmark + classification.
  const scored = eligible.map(t => {
    const raw = getMetricValue(t.ad, metric);
    const cmp = comparableScore(t.ad, metric, direction);
    return { ...t, raw_score: raw, score: cmp };
  }).filter(t => Number.isFinite(t.raw_score) && Number.isFinite(t.score));

  // Compute benchmark = median comparable score across eligible ads. Override-able for users
  // who have a hard target (e.g. "I need CPL under £30 — that's my benchmark").
  let benchmark = criteria.benchmark_override != null
    ? (direction === 'asc' && criteria.benchmark_override > 0 ? 1 / criteria.benchmark_override : criteria.benchmark_override)
    : median(scored.map(t => t.score));

  // Classify each scored ad.
  const classified = scored.map(t => {
    const cat = classify(t.ad, t.score, benchmark, criteria);
    const why = whyExplanation(cat, t.ad, t.score, benchmark, criteria);
    return { ...t, category: cat, why };
  });

  const winners = classified.filter(t => t.category === 'winner').slice().sort((a, b) => b.score - a.score).slice(0, criteria.top);
  const losers = classified.filter(t => t.category === 'loser').slice().sort((a, b) => a.score - b.score).slice(0, criteria.top);
  const contenders = classified.filter(t => t.category === 'contender');

  // Empty-state friendly output. Don't pretend there are winners/losers if there aren't.
  if (!classified.length) {
    logActivity(`Analyze (metric=${metric}, range=${range}) — no eligible ads`);
    process.stdout.write(JSON.stringify({
      ok: false,
      criteria, benchmark: null,
      analyzed: ads.length, eligible: 0, rejected: rejected.length,
      reason: `No ads passed the gates (min_spend ${fmtMoney(criteria.min_spend)} · min_days ${criteria.min_days} · ${criteria.include_video ? 'image+video' : 'image-only'}).`,
      hint: 'Lower --min-spend or --min-days, widen --range, or pass --include-video.',
      sample_rejections: rejected.slice(0, 8).map(t => ({ id: t.ad.id, name: t.ad.name, reasons: t.reasons })),
    }, null, 2) + '\n');
    process.exit(0);
  }

  // Merge with existing patterns, preserving enrichment for ads still in their bucket.
  const existingWinners = readPatterns(WINNERS_FILE);
  const existingLosers = readPatterns(LOSERS_FILE);
  const existingWinById = new Map(existingWinners.map(p => [p.source_ad_id, p]));
  const existingLoseById = new Map(existingLosers.map(p => [p.source_ad_id, p]));

  const newWinners = winners.map(t => {
    const skel = winnerSkeleton(t.ad, criteria, t.raw_score, benchmark, t.days_running, t.why);
    const prev = existingWinById.get(t.ad.id);
    if (prev && prev.enriched_at) {
      return { ...skel,
        confidence: prev.confidence, hook: prev.hook, copyable_pattern: prev.copyable_pattern,
        visual_notes: prev.visual_notes, winning_elements: prev.winning_elements,
        improvement_hypotheses: prev.improvement_hypotheses, meta_settings: prev.meta_settings,
        brief_addendum: prev.brief_addendum,
        enriched_at: prev.enriched_at, amplified_runs: prev.amplified_runs || [],
      };
    }
    return skel;
  });

  const newLosers = losers.map(t => {
    const skel = loserSkeleton(t.ad, criteria, t.raw_score, benchmark, t.days_running, t.why);
    const prev = existingLoseById.get(t.ad.id);
    if (prev && prev.enriched_at) {
      return { ...skel,
        confidence: prev.confidence, hook_observed: prev.hook_observed, visual_notes: prev.visual_notes,
        failure_modes: prev.failure_modes, change_hypotheses: prev.change_hypotheses,
        rewrite_or_pause: prev.rewrite_or_pause, rewrite_brief_addendum: prev.rewrite_brief_addendum,
        meta_settings: prev.meta_settings,
        enriched_at: prev.enriched_at, rewrite_runs: prev.rewrite_runs || [],
      };
    }
    return skel;
  });

  // Carry over runs from dropped winners/losers so we don't lose audit history.
  const droppedWinners = existingWinners.filter(p => !newWinners.find(w => w.source_ad_id === p.source_ad_id) && (p.amplified_runs || []).length);
  const droppedLosers = existingLosers.filter(p => !newLosers.find(l => l.source_ad_id === p.source_ad_id) && (p.rewrite_runs || []).length);

  writePatterns(WINNERS_FILE, [...newWinners, ...droppedWinners.map(p => ({ ...p, dropped_from_top_at: new Date().toISOString() }))]);
  writePatterns(LOSERS_FILE, [...newLosers, ...droppedLosers.map(p => ({ ...p, dropped_from_top_at: new Date().toISOString() }))]);

  logActivity(`Analyze done — ${newWinners.length} winners, ${contenders.length} contenders, ${newLosers.length} losers (metric=${metric}, range=${range})`);

  process.stdout.write(JSON.stringify({
    ok: true,
    criteria,
    benchmark: benchmark != null ? Math.round((direction === 'asc' && benchmark > 0 ? 1 / benchmark : benchmark) * 100) / 100 : null,
    benchmark_explanation: benchmark != null
      ? `${direction === 'asc' ? 'Lower' : 'Higher'} ${metric.toUpperCase()} is better. Benchmark = median across ${scored.length} eligible ad${scored.length === 1 ? '' : 's'}. Winners must beat by ≥${criteria.winner_margin}%, losers fall behind by ≥${criteria.loser_margin}%.`
      : 'No benchmark — only one or zero ads with finite scores. All eligible ads land in contenders.',
    analyzed: ads.length, eligible: scored.length, rejected: rejected.length,
    winners: newWinners,
    contenders: contenders.map(t => ({
      source_ad_id: t.ad.id, source_ad_name: t.ad.name,
      thumb_url: t.ad.thumb_url, creative_format: t.ad.is_video ? 'video' : 'image',
      score_metric: metric, raw_score: t.raw_score,
      metrics: extractMetrics(t.ad), days_running: t.days_running,
      why: t.why,
      // Contenders aren't enriched — they're informational. No skeleton, no save.
    })),
    losers: newLosers,
    needs_winner_enrichment: newWinners.filter(p => !p.enriched_at).map(p => p.source_ad_id),
    needs_loser_enrichment: newLosers.filter(p => !p.enriched_at).map(p => p.source_ad_id),
    rejected_summary: rejected.slice(0, 8).map(t => ({ id: t.ad.id, name: t.ad.name, reasons: t.reasons })),
  }, null, 2) + '\n');
}

function cmdList(flags) {
  // List both files by default; allow --bucket winners|losers to scope.
  const bucket = flags.bucket;
  if (bucket === 'winners') return process.stdout.write(JSON.stringify({ patterns: readPatterns(WINNERS_FILE) }, null, 2) + '\n');
  if (bucket === 'losers')  return process.stdout.write(JSON.stringify({ patterns: readPatterns(LOSERS_FILE) }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    winners: readPatterns(WINNERS_FILE),
    losers: readPatterns(LOSERS_FILE),
  }, null, 2) + '\n');
}

function cmdShow(adId) {
  if (!adId) throw new Error('Need <ad_id>');
  const found = readPatterns(WINNERS_FILE).find(p => p.source_ad_id === adId)
             || readPatterns(LOSERS_FILE).find(p => p.source_ad_id === adId);
  if (!found) { process.stderr.write(`Not found: ${adId}\n`); process.exit(1); }
  process.stdout.write(JSON.stringify(found, null, 2) + '\n');
}

// Save routes by category. Auto-detected from the JSON shape: winning_elements → winner file,
// failure_modes → loser file. Explicit `category` field also honored.
function cmdSave(json) {
  if (!json) throw new Error('Need <enriched-pattern-json>');
  let enriched;
  try { enriched = JSON.parse(json); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  if (!enriched.source_ad_id) throw new Error('Pattern must have source_ad_id');

  const isLoser = enriched.category === 'loser' || Array.isArray(enriched.failure_modes);
  const isWinner = enriched.category === 'winner' || Array.isArray(enriched.winning_elements);
  if (!isLoser && !isWinner) {
    throw new Error('Pattern must include either `winning_elements` (winner) or `failure_modes` (loser)');
  }

  if (isWinner) {
    const required = ['confidence', 'hook', 'visual_notes', 'winning_elements', 'improvement_hypotheses', 'meta_settings'];
    const missing = required.filter(k => enriched[k] == null);
    if (missing.length) throw new Error(`Winner enrichment incomplete. Missing: ${missing.join(', ')}`);
    if (!Array.isArray(enriched.winning_elements) || enriched.winning_elements.length < 2)
      throw new Error('winning_elements must have ≥2 entries');
    if (!Array.isArray(enriched.improvement_hypotheses) || enriched.improvement_hypotheses.length < 2)
      throw new Error('improvement_hypotheses must have ≥2 entries');

    const existing = readPatterns(WINNERS_FILE);
    const idx = existing.findIndex(p => p.source_ad_id === enriched.source_ad_id);
    enriched.enriched_at = new Date().toISOString();
    if (idx >= 0) existing[idx] = { ...existing[idx], ...enriched, category: 'winner' };
    else existing.push({ ...enriched, category: 'winner' });
    writePatterns(WINNERS_FILE, existing);
    logActivity(`Winner enriched for ${enriched.source_ad_id}`);
    return process.stdout.write(JSON.stringify({ ok: true, bucket: 'winner', saved: enriched.source_ad_id, enriched_at: enriched.enriched_at }) + '\n');
  }

  // Loser path
  const required = ['confidence', 'visual_notes', 'failure_modes', 'change_hypotheses', 'rewrite_or_pause'];
  const missing = required.filter(k => enriched[k] == null);
  if (missing.length) throw new Error(`Loser enrichment incomplete. Missing: ${missing.join(', ')}`);
  if (!Array.isArray(enriched.failure_modes) || enriched.failure_modes.length < 2)
    throw new Error('failure_modes must have ≥2 entries');
  if (!Array.isArray(enriched.change_hypotheses) || enriched.change_hypotheses.length < 2)
    throw new Error('change_hypotheses must have ≥2 entries');
  if (!['rewrite', 'pause'].includes(enriched.rewrite_or_pause))
    throw new Error(`rewrite_or_pause must be 'rewrite' or 'pause'`);

  const existing = readPatterns(LOSERS_FILE);
  const idx = existing.findIndex(p => p.source_ad_id === enriched.source_ad_id);
  enriched.enriched_at = new Date().toISOString();
  if (idx >= 0) existing[idx] = { ...existing[idx], ...enriched, category: 'loser' };
  else existing.push({ ...enriched, category: 'loser' });
  writePatterns(LOSERS_FILE, existing);
  logActivity(`Loser enriched for ${enriched.source_ad_id} (${enriched.rewrite_or_pause})`);
  process.stdout.write(JSON.stringify({ ok: true, bucket: 'loser', saved: enriched.source_ad_id, enriched_at: enriched.enriched_at }) + '\n');
}

function cmdDelete(adId) {
  if (!adId) throw new Error('Need <ad_id>');
  const w = readPatterns(WINNERS_FILE);
  const l = readPatterns(LOSERS_FILE);
  const newW = w.filter(p => p.source_ad_id !== adId);
  const newL = l.filter(p => p.source_ad_id !== adId);
  if (newW.length === w.length && newL.length === l.length) { process.stderr.write(`Not found: ${adId}\n`); process.exit(1); }
  if (newW.length !== w.length) writePatterns(WINNERS_FILE, newW);
  if (newL.length !== l.length) writePatterns(LOSERS_FILE, newL);
  logActivity(`Pattern dropped for ${adId}`);
  process.stdout.write(JSON.stringify({ ok: true, deleted: adId }) + '\n');
}

// ============ Playbook rendering ============

function renderWinnerPlaybook({ pattern, brief, prompts, outputs, model, ts }) {
  const succeeded = outputs.filter(o => !o.error);
  const m = pattern.metrics || {}, ms = pattern.meta_settings || {};
  const winningEls = (pattern.winning_elements || []).map(s => `- ${s}`).join('\n');
  const hypotheses = (pattern.improvement_hypotheses || []).map((h, i) => {
    const v = succeeded[i];
    return `${i + 1}. **${h}** ${v ? `→ \`${v.id}.png\`` : '→ (not generated)'}`;
  }).join('\n');
  const variantsTable = succeeded.map((o, i) => `| ${i + 1} | \`${o.id}.png\` | ${pattern.improvement_hypotheses?.[i] || '—'} |`).join('\n');

  return `# Playbook · Amplifying ${pattern.source_ad_name}

Generated ${new Date(ts).toISOString()} · LOOPER V1 (winner amplify)

## Source winner

- **Ad:** ${pattern.source_ad_name} (\`${pattern.source_ad_id}\`)
- **Campaign:** ${pattern.source_campaign || '—'} · **Ad set:** ${pattern.source_adset || '—'}
- **Performance:** ${m.leads || 0} leads at ${fmtMoney(m.cpl || 0)} CPL · ${fmtMoney(m.spend || 0)} spend over ${pattern.days_running || '—'} days
- **Why this won:** ${pattern.why || '—'}
- **Confidence:** ${pattern.confidence?.enough_data ? '✓ enough data' : '⚠ low confidence'} — ${pattern.confidence?.reason || ''}

## Claude's analysis

**Hook:** ${pattern.hook || '—'}
**Pattern:** ${pattern.copyable_pattern || '—'}
**Visual notes:** ${pattern.visual_notes || '—'}

**Winning elements (preserve in variants):**
${winningEls}

**Hypotheses tested in this batch:**
${hypotheses}

## Variants generated

| # | File | Hypothesis |
|---|------|------------|
${variantsTable}

Reference image used: \`${pattern.thumb_url ? pattern.thumb_url.slice(0, 60) + '...' : '—'}\` · Model: \`${model}\`

## How to upload these to Meta Ads Manager

1. **Open Ads Manager** → ${pattern.source_campaign ? `**${pattern.source_campaign}** campaign` : 'your lead-gen campaign'}.
2. **Duplicate** ${pattern.source_adset ? `the **${pattern.source_adset}** ad set` : 'the winning ad set'} — carries over working audience + optimization goal.
3. **Daily budget per variant:** ${ms.daily_budget_each || '£5/day'}. Total ≈ winner's daily.
4. **${ms.ab_test_structure || 'Run all variants in one ad set, even split, ≥7 days.'}**
5. **Hit publish.** Monitor via Overview tab.

## Benchmarks

- **Target CPL:** ${ms.target_cpl || fmtMoney(m.cpl || 0)} (match the source).
- **Target CTR:** ${ms.target_ctr || ((m.link_ctr || m.ctr || 0).toFixed(2) + '%')}.
- **Kill threshold:** ${ms.kill_threshold || `pause variants with 3-day rolling CPL > ${fmtMoney((m.cpl || 20) * 1.5)}`}.

## Next iteration

Wait ≥7 days, then re-run \`looper analyze\`. The winner survives → seeds the next batch.
`;
}

function renderLoserPlaybook({ pattern, brief, prompts, outputs, model, ts }) {
  const succeeded = outputs.filter(o => !o.error);
  const m = pattern.metrics || {}, ms = pattern.meta_settings || {};
  const failures = (pattern.failure_modes || []).map(s => `- ${s}`).join('\n');
  const changes = (pattern.change_hypotheses || []).map((h, i) => {
    const v = succeeded[i];
    return `${i + 1}. **${h}** ${v ? `→ \`${v.id}.png\`` : '→ (not generated)'}`;
  }).join('\n');
  const variantsTable = succeeded.map((o, i) => `| ${i + 1} | \`${o.id}.png\` | ${pattern.change_hypotheses?.[i] || '—'} |`).join('\n');

  return `# Playbook · Rewriting ${pattern.source_ad_name} (loser → alternatives)

Generated ${new Date(ts).toISOString()} · LOOPER V1 (loser rewrite)

## Source loser

- **Ad:** ${pattern.source_ad_name} (\`${pattern.source_ad_id}\`)
- **Performance:** ${m.leads || 0} leads at ${fmtMoney(m.cpl || 0)} CPL · ${fmtMoney(m.spend || 0)} spend over ${pattern.days_running || '—'} days
- **Why this is losing:** ${pattern.why || '—'}
- **Recommended action:** **${pattern.rewrite_or_pause || 'rewrite'}**${pattern.rewrite_or_pause === 'pause' ? ' — Claude advises pause-only; no rewrites generated below.' : ''}

## Claude's analysis

**Visual notes (current):** ${pattern.visual_notes || '—'}
**Observed hook:** ${pattern.hook_observed || '—'}

**Failure modes:**
${failures}

**Change hypotheses (rewrites test these):**
${changes}

${pattern.rewrite_brief_addendum ? `**Direction for rewrites:** ${pattern.rewrite_brief_addendum}\n` : ''}
${pattern.rewrite_or_pause === 'pause' ? '' : `## Rewrite variants generated

| # | File | Change hypothesis |
|---|------|-------------------|
${variantsTable}

These were generated WITHOUT the loser's image as a reference — the goal is to AVOID the failing approach, not replicate it. Model: \`${model}\``}

## How to deploy

${pattern.rewrite_or_pause === 'pause' ? `**Pause this ad in Ads Manager.** Don't replace it from this run — Claude's analysis says rewriting won't help. Investigate the audience/offer instead.` : `1. **Pause the original loser** in Ads Manager. Don't keep spending on it.
2. **Open the existing ad set** (${pattern.source_adset || '—'}) or duplicate it if you want isolation.
3. **Add ${succeeded.length} new ads** using the rewrite variants. Use a fresh headline that aligns with the change hypotheses.
4. **${ms.ab_test_structure || 'Even split, ≥7 days, then re-run looper analyze.'}**`}

${ms.target_cpl ? `## Benchmarks\n- **Target CPL:** ${ms.target_cpl}\n- **Kill threshold:** ${ms.kill_threshold || 'reapply the loser-margin gate next round'}\n` : ''}
## Next iteration

Re-run \`looper analyze\` after ≥7 days. If a rewrite breaks into the winner bucket, amplify it.
`;
}

// ============ Amplify (winners) and Rewrite (losers) ============

async function runFalForge(briefId, variations, model) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const promptsFile = path.join(TMP_DIR, `looper-${Date.now().toString(36)}.json`);
  fs.writeFileSync(promptsFile, JSON.stringify(variations, null, 2));
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'forge.js'),
      'generate', briefId,
      '--prompts-file', promptsFile,
      '--model', model,
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    proc.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`FORGE exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`FORGE output not JSON: ${e.message}`)); }
    });
  });
}

function resolveBriefId(flag) {
  if (flag) return flag;
  if (!fs.existsSync(BRIEFS_DIR)) throw new Error('No briefs found — run /scraper first or pass --brief-id');
  const files = fs.readdirSync(BRIEFS_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) throw new Error('No briefs in state/briefs/ — run /scraper first or pass --brief-id');
  files.sort((a, b) => fs.statSync(path.join(BRIEFS_DIR, b)).mtimeMs - fs.statSync(path.join(BRIEFS_DIR, a)).mtimeMs);
  return files[0].replace(/\.json$/, '');
}

async function cmdAmplify(adId, flags) {
  if (!adId) throw new Error('Need <ad_id>');
  const requestedN = parseInt(flags.n || '4', 10);
  const model = flags.model || 'nano-banana-2';

  const pattern = readPatterns(WINNERS_FILE).find(p => p.source_ad_id === adId);
  if (!pattern) throw new Error(`No winner pattern for ${adId}. Run \`looper.js analyze\` first.`);
  if (!pattern.thumb_url) throw new Error(`Pattern for ${adId} has no thumb_url`);
  if (!pattern.enriched_at) throw new Error(`Pattern for ${adId} hasn't been enriched. Run /looper in Claude Code.`);
  if (pattern.creative_format === 'video') throw new Error(`Pattern is video — FORGE generates images only.`);

  const hypotheses = pattern.improvement_hypotheses || [];
  const winningEls = pattern.winning_elements || [];
  if (!hypotheses.length) throw new Error('Pattern has no improvement_hypotheses');

  const briefId = resolveBriefId(flags['brief-id']);
  const preserved = winningEls.length ? `Preserve these winning elements: ${winningEls.join('; ')}.` : '';
  const addendum = pattern.brief_addendum ? ` ${pattern.brief_addendum}` : '';

  // Amplify prompts intentionally minimal: the reference image (the winner) carries every aesthetic
  // signal — composition, palette, lighting, text-overlay, faces. We don't add aesthetic adjectives;
  // doing so would override what's already winning. The prompt only carries the variation hypothesis
  // + the winning_elements to preserve.
  const variations = hypotheses.slice(0, requestedN).map((hyp, i) => ({
    hook: `winner_${(pattern.hook || 'x').toLowerCase()}_${i + 1}`,
    prompt: `Match the reference image's visual style exactly — composition, palette, lighting, mood, any text overlay or graphic elements. Variation: ${hyp}. ${preserved}${addendum} 1:1 aspect ratio.`,
    reference_images: [pattern.thumb_url],
    amplifies: pattern.source_ad_id,
    amplify_pattern_hook: pattern.hook || null,
    amplify_pattern_addendum: pattern.brief_addendum || null,
  }));
  const actualN = variations.length;

  fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
  const ts = Date.now();
  const tsKey = ts.toString(36);

  logActivity(`Amplify start — ad=${adId}, brief=${briefId}, n=${actualN}, model=${model}`);
  const result = await runFalForge(briefId, variations, model);

  const briefPath = path.join(BRIEFS_DIR, `${briefId}.json`);
  const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : { id: briefId, product_name: briefId };
  const playbookFile = path.join(PLAYBOOKS_DIR, `${adId}_${tsKey}.md`);
  fs.writeFileSync(playbookFile, renderWinnerPlaybook({ pattern, brief, prompts: variations, outputs: result.outputs || [], model, ts }));

  const outputIds = (result.outputs || []).filter(o => !o.error).map(o => o.id);
  const updated = readPatterns(WINNERS_FILE);
  const idx = updated.findIndex(p => p.source_ad_id === adId);
  if (idx >= 0) {
    updated[idx].amplified_runs.push({
      ts: new Date(ts).toISOString(), brief_id: briefId,
      n_requested: actualN, n_succeeded: outputIds.length,
      output_ids: outputIds, model,
      playbook_path: path.relative(ROOT, playbookFile).replace(/\\/g, '/'),
    });
    writePatterns(WINNERS_FILE, updated);
  }

  logActivity(`Amplify done — ${outputIds.length}/${actualN} variants`);
  process.stdout.write('\n' + JSON.stringify({
    ok: outputIds.length > 0, bucket: 'winner',
    rendered: outputIds.length, requested: actualN,
    playbook: path.relative(ROOT, playbookFile).replace(/\\/g, '/'),
    output_ids: outputIds,
  }, null, 2) + '\n');
}

async function cmdRewrite(adId, flags) {
  if (!adId) throw new Error('Need <ad_id>');
  const requestedN = parseInt(flags.n || '4', 10);
  const model = flags.model || 'nano-banana-2';

  const pattern = readPatterns(LOSERS_FILE).find(p => p.source_ad_id === adId);
  if (!pattern) throw new Error(`No loser pattern for ${adId}. Run \`looper.js analyze\` first.`);
  if (!pattern.enriched_at) throw new Error(`Pattern for ${adId} hasn't been enriched. Run /looper in Claude Code.`);
  if (pattern.rewrite_or_pause === 'pause') {
    throw new Error(`Pattern recommends PAUSE, not rewrite. Claude's analysis says rewriting won't help here — investigate audience/offer instead.`);
  }

  const changes = pattern.change_hypotheses || [];
  const failures = pattern.failure_modes || [];
  if (!changes.length) throw new Error('Pattern has no change_hypotheses');

  const briefId = resolveBriefId(flags['brief-id']);
  const avoidClause = failures.length ? `AVOID these failure modes: ${failures.join('; ')}.` : '';
  const addendum = pattern.rewrite_brief_addendum ? ` ${pattern.rewrite_brief_addendum}` : '';

  // Rewrite prompts: no reference image (we're explicitly avoiding the loser's visual approach).
  // We carry the change_hypothesis + the failure modes to avoid. Like amplify, we intentionally
  // don't add aesthetic adjectives — the change_hypothesis itself is what drives the new direction.
  // If the user wants the rewrite to inherit a different competitor's style, they should have
  // saved that as a RESEARCHER pattern and invoked /forge instead — rewrite is for trying
  // structurally different approaches, not for borrowing a specific look.
  const variations = changes.slice(0, requestedN).map((hyp, i) => ({
    hook: `rewrite_${i + 1}`,
    prompt: `Test this alternative direction: ${hyp}. ${avoidClause}${addendum} 1:1 aspect ratio.`,
    reference_images: [],
    rewrites: pattern.source_ad_id,
    rewrite_failure_modes: failures,
  }));
  const actualN = variations.length;

  fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
  const ts = Date.now();
  const tsKey = ts.toString(36);

  logActivity(`Rewrite start — ad=${adId}, brief=${briefId}, n=${actualN}`);
  const result = await runFalForge(briefId, variations, model);

  const briefPath = path.join(BRIEFS_DIR, `${briefId}.json`);
  const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : { id: briefId, product_name: briefId };
  const playbookFile = path.join(PLAYBOOKS_DIR, `${adId}_rewrite_${tsKey}.md`);
  fs.writeFileSync(playbookFile, renderLoserPlaybook({ pattern, brief, prompts: variations, outputs: result.outputs || [], model, ts }));

  const outputIds = (result.outputs || []).filter(o => !o.error).map(o => o.id);
  const updated = readPatterns(LOSERS_FILE);
  const idx = updated.findIndex(p => p.source_ad_id === adId);
  if (idx >= 0) {
    updated[idx].rewrite_runs.push({
      ts: new Date(ts).toISOString(), brief_id: briefId,
      n_requested: actualN, n_succeeded: outputIds.length,
      output_ids: outputIds, model,
      playbook_path: path.relative(ROOT, playbookFile).replace(/\\/g, '/'),
    });
    writePatterns(LOSERS_FILE, updated);
  }

  logActivity(`Rewrite done — ${outputIds.length}/${actualN} alternatives`);
  process.stdout.write('\n' + JSON.stringify({
    ok: outputIds.length > 0, bucket: 'loser',
    rendered: outputIds.length, requested: actualN,
    playbook: path.relative(ROOT, playbookFile).replace(/\\/g, '/'),
    output_ids: outputIds,
  }, null, 2) + '\n');
}

function cmdHelp() {
  process.stdout.write(`LOOPER — V1 self-learning feedback loop

  Three buckets: 🏆 winners · ⚖ contenders · ⚠ losers
  Closes the loop: live perf → Claude analyses both ends → FORGE makes targeted variants → playbook.

  Usage:
    node scripts/looper.js analyze
        [--metric cpl|leads|roas|ctr|cpm|reach|spend]   default: cpl
        [--direction asc|desc]                          default: inferred
        [--min-spend N]                                 default: 50
        [--min-days N]                                  default: 7
        [--top N]                                       default: 3
        [--include-video]                               default: image-only
        [--range R]                                     default: 180d
        [--winner-margin N]                             default: 20  (% better than benchmark)
        [--loser-margin N]                              default: 50  (% worse than benchmark)
        [--benchmark V]                                 default: median  (override fixed target)

    node scripts/looper.js list [--bucket winners|losers]
    node scripts/looper.js show <ad_id>
    node scripts/looper.js save '<enriched-pattern-json>'   (auto-routes by category)
    node scripts/looper.js delete <ad_id>
    node scripts/looper.js amplify <ad_id> [--n 4] [--brief-id ID] [--model M]
        Generates variants of a WINNER. Refuses if pattern not enriched.
    node scripts/looper.js rewrite <ad_id> [--n 4] [--brief-id ID] [--model M]
        Generates ALTERNATIVES to a LOSER. No reference image — AVOIDS the loser's approach.
        Refuses if pattern recommends pause.
`);
}

// ============ Main ============

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'analyze':  await cmdAnalyze(parseFlags(args)); break;
      case 'list':     cmdList(parseFlags(args)); break;
      case 'show':     cmdShow(args[0]); break;
      case 'save':     cmdSave(args[0]); break;
      case 'delete':   cmdDelete(args[0]); break;
      case 'amplify': {
        const [first, ...rest] = args;
        await cmdAmplify(first, parseFlags(rest));
        break;
      }
      case 'rewrite': {
        const [first, ...rest] = args;
        await cmdRewrite(first, parseFlags(rest));
        break;
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:  cmdHelp(); break;
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
