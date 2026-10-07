/**
 * Player Feedback Digest: collector entry points and shared helpers (Google Apps Script).
 *
 * Each weekly run, for every source:
 *   1. deletes rows older than that source's retention period
 *   2. (Reddit) deletes rows whose post or comment was deleted or removed on Reddit
 *   3. collects new items that mention a configured brand
 *   4. appends them to the Raw tab: no author names or handles stored, @/u/ mentions and emails redacted
 *   5. writes one line per source to the Run log tab
 *
 * Functions to run by hand from the editor:
 *   testSources()            check each source's keys and reach it (a few requests each)
 *   postDataForSEOTasks()    ask DataForSEO for the latest Trustpilot and App Store reviews (ready minutes later)
 *   runWeekly()              one full run (collects any DataForSEO results that are ready)
 *   setupWeeklyTriggers()    Mondays: postDataForSEOTasks around 5am, runWeekly around 6am (script time zone)
 */

const RAW_HEADERS = [
  'item_id', 'source', 'channel', 'brand', 'kind', 'post_date', 'url',
  'rating', 'score', 'text', 'collected_at', 'welfare_check',
];
const LOG_HEADERS = ['run_at', 'source', 'requests', 'added', 'removed_deleted', 'removed_expired', 'notes'];
const COL = RAW_HEADERS.reduce(function (m, h, i) { m[h] = i; return m; }, {});

/* ---------- Entry points ---------- */

function runWeekly() {
  const runAt = new Date();
  const sheet = getOrCreateSheet_(CONFIG.sheetName, RAW_HEADERS);
  const sources = [
    { name: 'Reddit', run: runReddit_ },
    { name: 'App Store', run: runAppStore_ },
    { name: 'Trustpilot', run: runTrustpilot_ },
    { name: 'YouTube', run: runYouTube_ },
  ];

  sources.forEach(function (src) {
    const ctx = newCtx_(src.name);
    let added = 0;
    let removedDeleted = 0;
    const removedExpired = purgeExpired_(sheet, src.name);
    try {
      const result = src.run(sheet, ctx) || {};
      removedDeleted = result.removedDeleted || 0;
      added = appendNew_(sheet, result.items || []);
    } catch (e) {
      ctx.notes.push(errorText_(e));
    }
    logRun_(runAt, src.name, ctx, added, removedDeleted, removedExpired);
    console.log(src.name + ': ' + ctx.requests + ' requests, ' + added + ' added, ' + removedDeleted +
      ' removed (deleted at source), ' + removedExpired + ' removed (expired). ' + ctx.notes.join(' | '));
  });
}

function testSources() {
  [testReddit_, testDataForSEO_, testYouTube_].forEach(function (fn) {
    try { console.log(fn()); } catch (e) { console.error(errorText_(e)); }
  });
}

function setupWeeklyTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) {
      return ['runWeekly', 'postTrustpilotTasks', 'postDataForSEOTasks'].indexOf(t.getHandlerFunction()) !== -1;
    })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('postDataForSEOTasks').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(5).create();
  ScriptApp.newTrigger('runWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  console.log('Weekly triggers set for Mondays (' + Session.getScriptTimeZone() + '): ' +
    'postDataForSEOTasks around 5am, runWeekly around 6am.');
}

/* ---------- Shared helpers ---------- */

function newCtx_(source) {
  return { source: source, requests: 0, notes: [] };
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function hasProps_(keys) {
  return keys.every(function (k) { return !!prop_(k); });
}

/** HTTP request that records the call, returns parsed JSON, and throws on non-2xx. */
function fetchJson_(url, options, ctx) {
  const opts = Object.assign({ muteHttpExceptions: true }, options || {});
  const res = UrlFetchApp.fetch(url, opts);
  ctx.requests++;
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    let detail = '';
    try {
      const j = JSON.parse(body);
      detail = j.status_message || (j.error && j.error.message) || j.message || '';
    } catch (x) { /* not JSON */ }
    const err = new Error(ctx.source + ' HTTP ' + code + ' for ' + url.split('?')[0] + (detail ? ': ' + detail : ''));
    err.code = code;
    err.body = body;
    throw err;
  }
  return JSON.parse(body);
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

/** Remove email addresses, @handles and u/usernames from text. */
function redact_(text) {
  return (text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(^|[^A-Za-z0-9_])@[A-Za-z0-9_.-]{2,30}/g, '$1[user]')
    .replace(/(^|[^A-Za-z0-9_])\/?u\/[A-Za-z0-9_-]{3,20}/g, '$1[user]');
}

function wordCount_(text) {
  const words = (text || '').trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

/**
 * Build a Raw row, or null if the text is too short.
 * f: { id, source, channel, brand, kind, date (Date), url, rating, score, text, welfare }
 */
function makeRow_(f) {
  let text = redact_(f.text).trim();
  if (wordCount_(text) < CONFIG.minWords) return null;
  if (text.length > CONFIG.maxTextChars) text = text.slice(0, CONFIG.maxTextChars) + ' […]';
  return [
    f.id, f.source, f.channel || '', f.brand, f.kind,
    f.date.toISOString().slice(0, 10), f.url || '',
    f.rating === undefined || f.rating === null ? '' : f.rating,
    f.score === undefined || f.score === null ? '' : f.score,
    text, new Date().toISOString(), f.welfare === false ? 'N' : 'Y',
  ];
}

function lookbackCutoff_() {
  return new Date(Date.now() - CONFIG.lookbackDays * 86400 * 1000);
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

function purgeExpired_(sheet, source) {
  const days = CONFIG.retentionDays[source] || 90;
  const cutoff = Date.now() - days * 86400 * 1000;
  return rewriteRows_(sheet, function (row) {
    if (row[COL.source] !== source) return true;
    const t = new Date(row[COL.collected_at]).getTime();
    return isNaN(t) || t >= cutoff;
  });
}

function appendNew_(sheet, items) {
  const seen = {};
  dataRows_(sheet).forEach(function (r) { seen[String(r[COL.item_id])] = true; });
  const fresh = items.filter(function (it) {
    if (!it || seen[it[COL.item_id]]) return false;
    seen[it[COL.item_id]] = true;
    return true;
  });
  if (fresh.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, RAW_HEADERS.length).setValues(fresh);
  }
  return fresh.length;
}

function logRun_(runAt, source, ctx, added, removedDeleted, removedExpired) {
  const log = getOrCreateSheet_(CONFIG.logSheetName, LOG_HEADERS);
  log.appendRow([runAt.toISOString(), source, ctx.requests, added, removedDeleted, removedExpired,
    ctx.notes.join(' | ')]);
}

function errorText_(e) {
  return String((e && e.message) || e);
}
