/**
 * Meta Marketing API client (v25.0)
 *
 * Thin wrapper over Graph API. Reads credentials from `.env` on every call
 * so /config updates are picked up without restarting the server. Transforms
 * Meta's response shape into the dashboard's ADS[] shape.
 */

const fs = require('fs');
const path = require('path');

const META_API_VERSION = 'v25.0';
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// ============ .env loader ============

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function credentials() {
  const env = readEnv();
  const token = env.META_ACCESS_TOKEN || null;
  let acct = env.META_AD_ACCOUNT_ID || null;
  if (acct && !acct.startsWith('act_')) acct = 'act_' + acct;
  return { token, acct, pixelId: env.META_PIXEL_ID || null };
}

function isConfigured() {
  const { token, acct } = credentials();
  return !!(token && acct);
}

// ============ HTTP ============

async function graphGet(pathname, params = {}) {
  const { token } = credentials();
  if (!token) {
    const err = new Error('META_ACCESS_TOKEN not set');
    err.code = 'NO_TOKEN';
    throw err;
  }
  const url = new URL(GRAPH + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  url.searchParams.set('access_token', token);

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Meta HTTP ${res.status}`);
    err.code = body?.error?.code;
    err.subcode = body?.error?.error_subcode;
    err.http = res.status;
    err.type = body?.error?.type;
    throw err;
  }
  return { data: body, usage: res.headers.get('x-business-use-case-usage') };
}

// ============ Endpoints ============

async function getAccount() {
  const { acct } = credentials();
  if (!acct) throw new Error('META_AD_ACCOUNT_ID not set');
  const r = await graphGet(`/${acct}`, {
    fields: 'id,name,account_status,currency,timezone_name,amount_spent,balance',
  });
  return r.data;
}

async function listAds(limit = 50) {
  const { acct } = credentials();
  if (!acct) throw new Error('META_AD_ACCOUNT_ID not set');
  const r = await graphGet(`/${acct}/ads`, {
    fields: [
      'id',
      'name',
      'status',
      'effective_status',
      'created_time',
      'adset{id,name,daily_budget,lifetime_budget,optimization_goal}',
      'campaign{id,name,objective}',
      // image_url + asset_feed.images.hash give us the high-res ad creative; thumbnail_url is the
      // 64×64 fallback that we only use if nothing else is available.
      'creative{id,image_url,thumbnail_url,asset_feed_spec{images{hash},videos{video_id,thumbnail_url}},object_story_spec{video_data{image_url,video_id},link_data{message,picture}}}',
    ].join(','),
    limit,
  });
  return r.data;
}

// Batch-resolve a list of image hashes → full-resolution CDN URLs via /act_X/adimages.
// Returns Map<hash, url>. Empty input → empty map. Errors swallowed (we still want ads to render
// even if the image lookup fails — they'll just keep the small thumbnail).
async function resolveImageHashes(hashes) {
  const out = new Map();
  if (!hashes || !hashes.length) return out;
  const { acct } = credentials();
  if (!acct) return out;
  try {
    const r = await graphGet(`/${acct}/adimages`, {
      fields: 'hash,url,permalink_url,width,height',
      hashes,
    });
    for (const img of r.data?.data || []) {
      if (img.hash && img.url) out.set(img.hash, img.url);
    }
  } catch (_) { /* keep ads renderable even if hash lookup fails */ }
  return out;
}

// Map a dashboard range key to Meta API params. Meta has no `last_180d` preset,
// so for 180d we compute an explicit time_range in UTC.
const RANGE_KEYS = ['7d', '30d', '90d', '180d', 'max'];
function resolveRange(range) {
  switch (range) {
    case '7d':   return { date_preset: 'last_7d' };
    case '30d':  return { date_preset: 'last_30d' };
    case '90d':  return { date_preset: 'last_90d' };
    case 'max':  return { date_preset: 'maximum' };
    case '180d': {
      const until = new Date();
      const since = new Date(until.getTime() - 180 * 24 * 60 * 60 * 1000);
      const fmt = d => d.toISOString().slice(0, 10);
      return { time_range: { since: fmt(since), until: fmt(until) } };
    }
    default:     return { date_preset: 'last_7d' };
  }
}

// Action types Meta uses for "a lead happened". We sum across these to get a single "leads" count.
// Source: developers.facebook.com/docs/marketing-api/insights/breakdowns#actiontype
const LEAD_ACTION_TYPES = new Set([
  'lead',
  'leadgen.other',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);
const INSIGHT_FIELDS_AD = [
  'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'frequency',
  'clicks', 'inline_link_clicks',
  'ctr', 'inline_link_click_ctr',
  'cpc', 'cpm', 'cost_per_inline_link_click',
  'purchase_roas',
  'actions', 'cost_per_action_type',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions',
  'video_thruplay_watched_actions', 'video_avg_time_watched_actions',
].join(',');

async function getInsights(range = '7d') {
  const { acct } = credentials();
  if (!acct) throw new Error('META_AD_ACCOUNT_ID not set');
  const r = await graphGet(`/${acct}/insights`, {
    level: 'ad',
    fields: INSIGHT_FIELDS_AD,
    ...resolveRange(range),
    action_attribution_windows: ['1d_view', '7d_click'],
    limit: 500,
  });
  return r.data;
}

async function getAccountInsightsTimeSeries(range = '7d') {
  const { acct } = credentials();
  if (!acct) throw new Error('META_AD_ACCOUNT_ID not set');
  const r = await graphGet(`/${acct}/insights`, {
    level: 'account',
    fields: 'spend,impressions,clicks,actions,purchase_roas',
    time_increment: 1,
    ...resolveRange(range),
    action_attribution_windows: ['1d_view', '7d_click'],
  });
  return r.data;
}

// On-demand creative lookup. We fetch ad → creative + video source in one round-trip per kind so the
// frontend lightbox can show a real, playable asset (not the 64×64 thumbnail). The `source` URL Meta
// returns for videos is short-lived and unsigned — caller is expected to cache for ≤5 min.
async function getPlayableCreative(adId) {
  if (!adId) throw new Error('ad_id required');
  const adFields = 'creative{id,image_url,thumbnail_url,asset_feed_spec{images{hash}},object_story_spec{link_data{picture,image_hash},video_data{video_id,image_url}}}';
  const adResp = await graphGet(`/${adId}`, { fields: adFields });
  const creative = adResp.data?.creative || {};
  const oss = creative.object_story_spec || {};
  const videoId = oss.video_data?.video_id || null;
  // Resolve the first asset_feed image hash to a high-res URL — same fix we applied for card thumbs.
  // Without this, image ads using Meta's multi-asset (asset_feed) creatives fall through to the 64×64
  // thumbnail and look tiny in the lightbox.
  const feedImageHash = creative.asset_feed_spec?.images?.[0]?.hash || null;
  let feedImageUrl = null;
  if (feedImageHash) {
    const map = await resolveImageHashes([feedImageHash]);
    feedImageUrl = map.get(feedImageHash) || null;
  }
  const imageUrl = feedImageUrl
    || creative.image_url
    || oss.link_data?.picture
    || oss.video_data?.image_url
    || creative.thumbnail_url
    || null;

  if (videoId) {
    let video = {};
    try {
      const vResp = await graphGet(`/${videoId}`, { fields: 'source,permalink_url,embed_html,picture' });
      video = vResp.data || {};
    } catch (e) {
      // Most common cause: token lacks pages_read_engagement on the owning Page. We still return
      // the embed_html-less response so the frontend can fall back to the public plugin URL.
      video = { error: e.message, code: e.code };
    }
    return {
      kind: 'video',
      video_id: videoId,
      source_url: video.source || null,
      embed_html: video.embed_html || null,
      permalink_url: video.permalink_url || null,
      poster_url: video.picture || imageUrl,
      image_url: imageUrl,
      creative_id: creative.id || null,
      error: video.error || null,
    };
  }
  return {
    kind: 'image',
    image_url: imageUrl,
    creative_id: creative.id || null,
  };
}

// ============ Transforms ============

function statusToDashboard(effectiveStatus) {
  if (!effectiveStatus) return 'ended';
  const s = String(effectiveStatus).toUpperCase();
  if (s === 'ACTIVE' || s === 'DELIVERING') return 'active';
  if (s === 'PAUSED' || s === 'ADSET_PAUSED' || s === 'CAMPAIGN_PAUSED') return 'paused';
  if (s === 'IN_PROCESS' || s === 'WITH_ISSUES' || s === 'PENDING_REVIEW' || s === 'LEARNING') return 'learning';
  return 'ended';
}

function inferObjective(ad) {
  const obj = (ad.campaign?.objective || 'UNKNOWN').replace('OUTCOME_', '');
  const isVideo = !!ad.creative?.object_story_spec?.video_data;
  return `${obj} · ${isVideo ? 'VIDEO' : 'IMAGE'}`;
}

function parseRoas(purchaseRoas) {
  if (!Array.isArray(purchaseRoas)) return 0;
  const entry = purchaseRoas.find(r => r.action_type === 'omni_purchase') || purchaseRoas[0];
  return entry ? parseFloat(entry.value) || 0 : 0;
}

function parseConversions(actions) {
  if (!Array.isArray(actions)) return 0;
  const entry =
    actions.find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase') ||
    actions.find(a => a.action_type === 'lead') ||
    actions.find(a => a.action_type === 'complete_registration');
  return entry ? parseInt(entry.value, 10) || 0 : 0;
}

// Lead-counting is tricky because Meta reports the SAME lead under multiple action_type keys.
// Empirically observed for lead-gen ads: { lead: N, onsite_conversion.lead_grouped: N } both
// contain the identical set. Summing them double-counts.
//
// Strategy:
//   - `lead` is Meta's authoritative aggregate for on-platform leads. Use it when present.
//   - Fall back to lead_grouped (the on-platform-specific) or leadgen.other when `lead` is missing.
//   - `offsite_conversion.fb_pixel_lead` may be additional (separate Pixel events not in `lead`).
//     Take max with onsite to be conservative — never double-count, possibly slightly under-count.
function parseLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const byType = {};
  for (const a of actions) {
    if (LEAD_ACTION_TYPES.has(a.action_type)) byType[a.action_type] = parseInt(a.value, 10) || 0;
  }
  const onsite = byType['lead'] != null
    ? byType['lead']
    : (byType['leadgen.other'] || 0) + (byType['onsite_conversion.lead_grouped'] || 0);
  const offsite = byType['offsite_conversion.fb_pixel_lead'] || 0;
  return Math.max(onsite, offsite);
}

// Cost-per-lead — same dedup logic. Prefer `lead`'s reported cost (single canonical number),
// fall back to lead_grouped or pixel_lead. These values are already averages per type, so we
// don't need to weight — we just pick the right one.
function parseCostPerLead(costPerActionType /*, actions — no longer needed */) {
  if (!Array.isArray(costPerActionType)) return 0;
  const lookup = (type) => {
    const entry = costPerActionType.find(c => c.action_type === type);
    return entry ? parseFloat(entry.value) || 0 : 0;
  };
  return lookup('lead')
    || lookup('onsite_conversion.lead_grouped')
    || lookup('leadgen.other')
    || lookup('offsite_conversion.fb_pixel_lead')
    || 0;
}

// All video_*_watched_actions arrays use the same {action_type, value} shape; sum the most relevant entries.
function parseVideoAction(arr) {
  if (!Array.isArray(arr)) return 0;
  const total = arr.find(a => a.action_type === 'video_view') || arr[0];
  return total ? parseInt(total.value, 10) || 0 : 0;
}

function parseVideoAvgSeconds(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const total = arr.find(a => a.action_type === 'video_view') || arr[0];
  return total ? parseFloat(total.value) || 0 : 0;
}

const GRADIENTS = [
  'linear-gradient(135deg,#0d4429 0%,#1a7a3e 100%)',
  'linear-gradient(135deg,#3a2a0d 0%,#8a6a1a 100%)',
  'linear-gradient(135deg,#2a0d3d 0%,#6a2a8a 100%)',
  'linear-gradient(135deg,#0d1a3d 0%,#2a4a8a 100%)',
  'linear-gradient(135deg,#3d0d0d 0%,#8a1a1a 100%)',
  'linear-gradient(135deg,#1a3d3d 0%,#3a7a7a 100%)',
  'linear-gradient(135deg,#0d0d1f 0%,#1a1a3d 100%)',
  'linear-gradient(135deg,#0d3d2a 0%,#1a7a55 100%)',
  'linear-gradient(135deg,#3d2a0d 0%,#8a6a1a 100%)',
  'linear-gradient(135deg,#1a1a1a 0%,#3d3d3d 100%)',
  'linear-gradient(135deg,#3d1a0d 0%,#8a3a1a 100%)',
];

function mergeAdsData(adsResponse, insightsResponse, imageHashMap = new Map()) {
  const insightsMap = new Map();
  for (const row of insightsResponse?.data || []) {
    insightsMap.set(row.ad_id, row);
  }
  return (adsResponse?.data || []).map((ad, idx) => {
    const ins = insightsMap.get(ad.id) || {};
    const spend = parseFloat(ins.spend || 0);
    const ctr = parseFloat(ins.ctr || 0);
    const linkCtr = parseFloat(ins.inline_link_click_ctr || 0);
    const roas = parseRoas(ins.purchase_roas);
    const conv = parseConversions(ins.actions);
    const leads = parseLeads(ins.actions);
    const cpl = parseCostPerLead(ins.cost_per_action_type);
    const impressions = parseInt(ins.impressions || 0, 10);
    const reach = parseInt(ins.reach || 0, 10);
    const frequency = parseFloat(ins.frequency || 0);
    const clicks = parseInt(ins.clicks || 0, 10);
    const linkClicks = parseInt(ins.inline_link_clicks || 0, 10);
    const cpc = parseFloat(ins.cpc || 0);
    const cpm = parseFloat(ins.cpm || 0);
    const costPerLinkClick = parseFloat(ins.cost_per_inline_link_click || 0);
    const v25 = parseVideoAction(ins.video_p25_watched_actions);
    const v50 = parseVideoAction(ins.video_p50_watched_actions);
    const v75 = parseVideoAction(ins.video_p75_watched_actions);
    const v100 = parseVideoAction(ins.video_p100_watched_actions);
    const thruplays = parseVideoAction(ins.video_thruplay_watched_actions);
    const avgVideoSec = parseVideoAvgSeconds(ins.video_avg_time_watched_actions);
    const dailyCents = parseFloat(ad.adset?.daily_budget || 0);
    const daily = dailyCents ? Math.round(dailyCents / 100) : 0;
    const oss = ad.creative?.object_story_spec || {};
    // First asset_feed image (resolved to high-res via /adimages) → otherwise direct creative.image_url
    // → otherwise the platform-specific picture fields → finally the 64×64 thumbnail as last resort.
    const feedImageHash = ad.creative?.asset_feed_spec?.images?.[0]?.hash || null;
    const feedImageUrl = feedImageHash ? imageHashMap.get(feedImageHash) : null;
    const thumb = feedImageUrl
      || ad.creative?.image_url
      || oss.video_data?.image_url
      || oss.link_data?.picture
      || ad.creative?.thumbnail_url
      || null;
    const videoId = oss.video_data?.video_id || null;
    return {
      id: ad.id,
      name: (ad.name || `Ad ${ad.id}`).toUpperCase(),
      created_time: ad.created_time || null,
      thumb_url: thumb,
      video_id: videoId,
      is_video: !!videoId,
      headline: ad.creative?.object_story_spec?.link_data?.message || '',
      campaign_id: ad.campaign?.id || null,
      campaign_name: ad.campaign?.name || '',
      campaign_objective: (ad.campaign?.objective || 'UNKNOWN').replace('OUTCOME_', ''),
      adset_id: ad.adset?.id || null,
      adset_name: ad.adset?.name || '',
      adset_optimization_goal: ad.adset?.optimization_goal || null,
      obj: inferObjective(ad),
      status: statusToDashboard(ad.effective_status),
      roas,
      ctr,
      link_ctr: linkCtr,
      spend: Math.round(spend * 100) / 100,
      conv,
      leads,
      cpl: Math.round(cpl * 100) / 100,
      impressions,
      reach,
      frequency: Math.round(frequency * 100) / 100,
      clicks,
      link_clicks: linkClicks,
      cpc: Math.round(cpc * 100) / 100,
      cpm: Math.round(cpm * 100) / 100,
      cost_per_link_click: Math.round(costPerLinkClick * 100) / 100,
      video: {
        p25: v25, p50: v50, p75: v75, p100: v100,
        thruplays,
        avg_seconds: Math.round(avgVideoSec * 10) / 10,
        completion_rate: v25 > 0 ? v100 / v25 : 0,
      },
      imgBg: GRADIENTS[idx % GRADIENTS.length],
      agent_idx: idx % 4,
      budget: daily ? Math.min(spend / daily, 1) : 0,
      daily,
    };
  });
}

module.exports = {
  META_API_VERSION,
  RANGE_KEYS,
  readEnv,
  credentials,
  isConfigured,
  graphGet,
  getAccount,
  listAds,
  resolveImageHashes,
  getInsights,
  getAccountInsightsTimeSeries,
  mergeAdsData,
  parseLeads,
  getPlayableCreative,
};
