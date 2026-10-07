/**
 * Player Feedback Digest: Reddit collector (Google Apps Script).
 *
 * Read-only. Uses application-only OAuth (no user login, no account acting on Reddit).
 * Each weekly run:
 *   1. deletes rows collected more than CONFIG.retentionDays ago
 *   2. re-checks stored items and deletes any that were deleted or removed on Reddit
 *   3. collects new posts and comments that mention a configured brand
 *   4. appends them to the Raw tab (no usernames stored; u/ mentions redacted)
 *   5. writes a line to the Run log tab
 *
 * Functions to run by hand from the editor:
 *   testConnection()      check credentials and reach Reddit (2 requests)
 *   runWeekly()           one full run
 *   setupWeeklyTrigger()  schedule runWeekly every Monday around 6am (script time zone)
 */

const RAW_HEADERS = [
  'item_id', 'source', 'subreddit', 'brand', 'kind', 'post_date',
  'url', 'score', 'text', 'collected_at', 'welfare_check',
];
const LOG_HEADERS = ['run_at', 'requests', 'added', 'removed_deleted', 'removed_expired', 'errors'];
const REMOVED_MARKERS = ['[deleted]', '[removed]'];

/* ---------- Entry points ---------- */

function runWeekly() {
  const ctx = { requests: 0, errors: [] };
  const startedAt = new Date();
  let added = 0;
  let removedDeleted = 0;
  let removedExpired = 0;

  try {
    const sheet = getOrCreateSheet_(CONFIG.sheetName, RAW_HEADERS);
    removedExpired = purgeExpired_(sheet);
    const token = redditToken_(ctx);
    removedDeleted = syncDeletions_(sheet, token, ctx);
    const items = collectReddit_(token, ctx);
    added = appendNew_(sheet, items);
  } catch (e) {
    ctx.errors.push(errorText_(e));
  }

  logRun_(startedAt, ctx, added, removedDeleted, removedExpired);
  console.log('Run complete: ' + ctx.requests + ' requests, ' + added + ' added, ' +
    removedDeleted + ' removed (deleted on Reddit), ' + removedExpired + ' removed (expired).');
  if (ctx.errors.length) console.error(ctx.errors.join('\n'));
}

function testConnection() {
  const ctx = { requests: 0, errors: [] };
  const token = redditToken_(ctx);
  const sub = CONFIG.reddit.subreddits[0].name;
  const listing = redditGet_('/r/' + sub + '/new', { limit: 5, raw_json: 1 }, token, ctx);
  console.log('Connected. Read ' + listingChildren_(listing).length + ' recent posts from r/' + sub +
    ' using ' + ctx.requests + ' requests.');
}

function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runWeekly'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runWeekly').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  console.log('Weekly trigger set: Mondays around 6am (' + Session.getScriptTimeZone() + ').');
}

/* ---------- Reddit API ---------- */

function redditToken_(ctx) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('REDDIT_CLIENT_ID');
  const secret = props.getProperty('REDDIT_CLIENT_SECRET');
  if (!id || !secret) {
    throw new Error('Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in Project Settings > Script properties.');
  }
  const res = UrlFetchApp.fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'post',
    payload: { grant_type: 'client_credentials' },
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret),
      'User-Agent': userAgent_(),
    },
    muteHttpExceptions: true,
  });
  ctx.requests++;
  if (res.getResponseCode() !== 200) {
    throw new Error('Reddit auth failed: HTTP ' + res.getResponseCode());
  }
  return JSON.parse(res.getContentText()).access_token;
}

function userAgent_() {
  const user = PropertiesService.getScriptProperties().getProperty('REDDIT_USERNAME') || 'unknown';
  return 'google-apps-script:player-feedback-digest:v0.2 (by /u/' + user + ')';
}

/** GET from the OAuth API. Throws on HTTP errors; returns null once the request cap is reached. */
function redditGet_(path, params, token, ctx) {
  if (ctx.requests >= CONFIG.maxRequestsPerRun) {
    const msg = 'Request cap reached (' + CONFIG.maxRequestsPerRun + '); remaining calls skipped.';
    if (ctx.errors.indexOf(msg) === -1) ctx.errors.push(msg);
    return null;
  }
  const query = Object.keys(params || {})
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  Utilities.sleep(CONFIG.requestDelayMs);
  const res = UrlFetchApp.fetch('https://oauth.reddit.com' + path + (query ? '?' + query : ''), {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': userAgent_() },
    muteHttpExceptions: true,
  });
  ctx.requests++;
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('GET ' + path + ' failed: HTTP ' + code);
  return JSON.parse(res.getContentText());
}

/** Like redditGet_, but records errors and returns null so one failed call doesn't stop the run. */
function safeGet_(path, params, token, ctx) {
  try {
    return redditGet_(path, params, token, ctx);
  } catch (e) {
    ctx.errors.push(errorText_(e));
    return null;
  }
}

function listingChildren_(listing) {
  if (!listing || !listing.data || !listing.data.children) return [];
  return listing.data.children.map(function (c) { return c.data; });
}

/* ---------- Collection ---------- */

function collectReddit_(token, ctx) {
  const cutoff = Date.now() / 1000 - CONFIG.lookbackDays * 86400;
  const posts = {}; // fullname -> { p, brand }

  CONFIG.reddit.subreddits.forEach(function (sub) {
    const listing = safeGet_('/r/' + sub.name + '/new', { limit: 100, raw_json: 1 }, token, ctx);
    listingChildren_(listing).forEach(function (p) {
      if (p.created_utc < cutoff || skipThing_(p)) return;
      const brand = detectBrand_(postText_(p)) || sub.defaultBrand;
      if (brand) posts[p.name] = { p: p, brand: brand };
    });
  });

  CONFIG.reddit.searchQueries.forEach(function (q) {
    const listing = safeGet_('/search',
      { q: q, sort: 'new', t: 'month', limit: 100, type: 'link', raw_json: 1 }, token, ctx);
    listingChildren_(listing).forEach(function (p) {
      if (posts[p.name] || p.created_utc < cutoff || skipThing_(p)) return;
      const brand = detectBrand_(postText_(p)); // search matches loosely, so require a keyword
      if (brand) posts[p.name] = { p: p, brand: brand };
    });
  });

  const items = [];
  const entries = Object.keys(posts).map(function (k) { return posts[k]; });

  entries.forEach(function (e) {
    const item = toItem_(e.p, 'post', e.brand, postText_(e.p), e.p.subreddit);
    if (item) items.push(item);
  });

  entries
    .filter(function (e) { return e.p.num_comments > 0; })
    .sort(function (a, b) { return b.p.num_comments - a.p.num_comments; })
    .slice(0, CONFIG.reddit.maxPostsForComments)
    .forEach(function (e) {
      const data = safeGet_('/comments/' + e.p.id,
        { limit: CONFIG.reddit.maxCommentsPerPost, depth: 3, sort: 'new', raw_json: 1 }, token, ctx);
      if (!data || !data[1]) return;
      flattenComments_(data[1]).forEach(function (c) {
        if (c.created_utc < cutoff || skipThing_(c)) return;
        const brand = detectBrand_(c.body) || e.brand;
        const item = toItem_(c, 'comment', brand, c.body, e.p.subreddit);
        if (item) items.push(item);
      });
    });

  return items;
}

function postText_(p) {
  return [p.title || '', p.selftext || ''].join('\n\n').trim();
}

/** Skip mod/bot posts and anything already deleted or removed. Author is checked here but never stored. */
function skipThing_(t) {
  if (t.stickied || t.distinguished || t.author === 'AutoModerator') return true;
  return isGone_(t);
}

function isGone_(t) {
  if (t.removed_by_category) return true;
  if (t.author === '[deleted]') return true;
  const body = (t.name && t.name.indexOf('t1_') === 0) ? t.body : t.selftext;
  return REMOVED_MARKERS.indexOf((body || '').trim()) !== -1;
}

function flattenComments_(listing) {
  const out = [];
  (function walk(node) {
    if (!node || !node.data || !node.data.children) return;
    node.data.children.forEach(function (child) {
      if (child.kind !== 't1') return; // skips "load more" stubs
      out.push(child.data);
      if (child.data.replies) walk(child.data.replies);
    });
  })(listing);
  return out;
}

/** Brand whose keyword appears earliest in the text, or null. */
function detectBrand_(text) {
  const lower = (text || '').toLowerCase();
  let best = null;
  let bestPos = Infinity;
  CONFIG.brands.forEach(function (b) {
    b.keywords.forEach(function (k) {
      const pos = lower.indexOf(k.toLowerCase());
      if (pos !== -1 && pos < bestPos) { best = b.name; bestPos = pos; }
    });
  });
  return best;
}

/** Remove usernames and email addresses from text. */
function redact_(text) {
  return (text || '')
    .replace(/(^|[^A-Za-z0-9_])\/?u\/[A-Za-z0-9_-]{3,20}/g, '$1[user]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}

function wordCount_(text) {
  const words = (text || '').trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

function toItem_(thing, kind, brand, rawText, subreddit) {
  let text = redact_(rawText).trim();
  if (wordCount_(text) < CONFIG.minWords) return null;
  if (text.length > CONFIG.maxTextChars) text = text.slice(0, CONFIG.maxTextChars) + ' […]';
  return [
    thing.name,                                         // item_id (t3_ = post, t1_ = comment)
    'Reddit',
    subreddit || thing.subreddit,
    brand,
    kind,
    new Date(thing.created_utc * 1000).toISOString().slice(0, 10),
    'https://www.reddit.com' + thing.permalink,
    thing.score,
    text,
    new Date().toISOString(),
    'N',                                                // welfare check never runs on Reddit data
  ];
}

/* ---------- Retention and deletion sync ---------- */

function purgeExpired_(sheet) {
  const cutoff = Date.now() - CONFIG.retentionDays * 86400 * 1000;
  const col = RAW_HEADERS.indexOf('collected_at');
  return rewriteRows_(sheet, function (row) {
    const t = new Date(row[col]).getTime();
    return isNaN(t) || t >= cutoff;
  });
}

/** Re-check every stored Reddit item; delete rows whose item is deleted, removed or no longer returned. */
function syncDeletions_(sheet, token, ctx) {
  const rows = dataRows_(sheet);
  const idCol = RAW_HEADERS.indexOf('item_id');
  const srcCol = RAW_HEADERS.indexOf('source');
  const ids = rows.filter(function (r) { return r[srcCol] === 'Reddit'; })
    .map(function (r) { return String(r[idCol]); });
  if (!ids.length) return 0;

  const gone = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = safeGet_('/api/info', { id: batch.join(','), raw_json: 1 }, token, ctx);
    if (!res) continue; // unknown status: keep the rows rather than guess
    const alive = {};
    listingChildren_(res).forEach(function (t) { if (!isGone_(t)) alive[t.name] = true; });
    batch.forEach(function (id) { if (!alive[id]) gone[id] = true; });
  }
  return rewriteRows_(sheet, function (row) {
    return !(row[srcCol] === 'Reddit' && gone[String(row[idCol])]);
  });
}

/* ---------- Sheet helpers ---------- */

function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function dataRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, RAW_HEADERS.length).getValues();
}

/** Keep rows where keep(row) is true; returns the number removed. */
function rewriteRows_(sheet, keep) {
  const rows = dataRows_(sheet);
  const kept = rows.filter(keep);
  const removed = rows.length - kept.length;
  if (removed === 0) return 0;
  sheet.getRange(2, 1, rows.length, RAW_HEADERS.length).clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, RAW_HEADERS.length).setValues(kept);
  return removed;
}

function appendNew_(sheet, items) {
  const idCol = RAW_HEADERS.indexOf('item_id');
  const seen = {};
  dataRows_(sheet).forEach(function (r) { seen[String(r[idCol])] = true; });
  const fresh = items.filter(function (it) {
    if (seen[it[idCol]]) return false;
    seen[it[idCol]] = true;
    return true;
  });
  if (fresh.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, RAW_HEADERS.length).setValues(fresh);
  }
  return fresh.length;
}

function logRun_(startedAt, ctx, added, removedDeleted, removedExpired) {
  const log = getOrCreateSheet_(CONFIG.logSheetName, LOG_HEADERS);
  log.appendRow([startedAt.toISOString(), ctx.requests, added, removedDeleted, removedExpired,
    ctx.errors.join(' | ')]);
}

function errorText_(e) {
  return String((e && e.message) || e);
}
