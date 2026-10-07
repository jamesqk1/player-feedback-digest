/**
 * DataForSEO: shared plumbing for the Trustpilot and App Store sources.
 * DataForSEO works in two steps:
 *   postDataForSEOTasks()  asks for each brand's most recent reviews (scheduled about an hour before runWeekly)
 *   runWeekly()            collects whichever tasks are ready; unfinished ones stay pending for the next run
 * Both sources are skipped until DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are set.
 * The cost DataForSEO reports for each task is noted in the Run log.
 */

const DFS_API = 'https://api.dataforseo.com/v3/';
const DFS_PENDING_KEY = 'DATAFORSEO_PENDING_TASKS';

/** Per-source settings: which brands, what to post, and where to collect results. */
const DFS_SOURCES = {
  'Trustpilot': {
    enabled: function () { return CONFIG.trustpilot.enabled; },
    brands: function () { return CONFIG.brands.filter(function (b) { return b.trustpilotDomain; }); },
    postUrl: 'business_data/trustpilot/reviews/task_post',
    getUrl: 'business_data/trustpilot/reviews/task_get/',
    task: function (b) {
      return { domain: b.trustpilotDomain, depth: CONFIG.trustpilot.depth, sort_by: 'recency', tag: b.name };
    },
  },
  'App Store': {
    enabled: function () { return CONFIG.appStore.enabled; },
    brands: function () { return CONFIG.brands.filter(function (b) { return b.appStoreId; }); },
    postUrl: 'app_data/apple/app_reviews/task_post',
    getUrl: 'app_data/apple/app_reviews/task_get/advanced/',
    task: function (b) {
      return {
        app_id: b.appStoreId, location_code: CONFIG.appStore.locationCode, language_code: CONFIG.appStore.languageCode,
        depth: CONFIG.appStore.depth, sort_by: 'most_recent', tag: b.name,
      };
    },
  },
};

function postDataForSEOTasks() {
  if (!hasProps_(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])) {
    console.log('DataForSEO: skipped (no keys).');
    return;
  }
  const pending = dfsPending_();
  const postedAt = new Date().toISOString();
  Object.keys(DFS_SOURCES).forEach(function (source) {
    const s = DFS_SOURCES[source];
    const brands = s.brands();
    if (!s.enabled() || !brands.length) return;
    const ctx = newCtx_(source);
    try {
      const json = fetchJson_(DFS_API + s.postUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(brands.map(s.task)),
        headers: { Authorization: dfsAuth_() },
      }, ctx);
      (json.tasks || []).forEach(function (t) {
        if (t.status_code === 20100 && t.id) {
          pending[t.id] = { source: source, brand: (t.data && t.data.tag) || '', postedAt: postedAt };
        } else {
          console.error(source + ' task not created: ' + t.status_code + ' ' + t.status_message);
        }
      });
    } catch (e) {
      console.error(source + ': ' + errorText_(e));
    }
  });
  PropertiesService.getScriptProperties().setProperty(DFS_PENDING_KEY, JSON.stringify(pending));
  console.log('DataForSEO: ' + Object.keys(pending).length + ' task(s) pending. Run runWeekly in a few minutes to collect.');
}

/** Kept so existing triggers named postTrustpilotTasks keep working. */
function postTrustpilotTasks() {
  postDataForSEOTasks();
}

/**
 * Collect ready tasks for one source. toRow(item, brand) turns one result item into a Raw row (or null).
 * Returns { items }.
 */
function dfsCollect_(source, ctx, toRow) {
  const s = DFS_SOURCES[source];
  if (!s.enabled()) { ctx.notes.push('disabled in Config'); return {}; }
  if (!hasProps_(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])) {
    ctx.notes.push('skipped: no DataForSEO keys yet');
    return {};
  }
  const pending = dfsPending_();
  const ids = Object.keys(pending).filter(function (id) { return pending[id].source === source; });
  if (!ids.length) {
    ctx.notes.push('no pending tasks: run postDataForSEOTasks first (scheduled automatically by setupWeeklyTriggers)');
    return {};
  }

  const items = [];
  let cost = 0;
  ids.forEach(function (id) {
    const task = pending[id];
    let json;
    try {
      json = fetchJson_(DFS_API + s.getUrl + id, { headers: { Authorization: dfsAuth_() } }, ctx);
    } catch (e) {
      ctx.notes.push(task.brand + ': ' + errorText_(e));
      return; // keep pending; try again next run
    }
    const t = (json.tasks || [])[0] || {};
    const notReady = t.status_code === 40602 || t.status_code === 40601 || (t.status_code === 20000 && !t.result);
    if (notReady) {
      ctx.notes.push(task.brand + ': task still in queue, will collect next run');
      return;
    }
    delete pending[id];
    cost += Number(t.cost) || 0;
    if (t.status_code !== 20000) {
      ctx.notes.push(task.brand + ': task failed (' + t.status_code + ' ' + t.status_message + ')');
      return;
    }
    const cutoff = new Date(new Date(task.postedAt).getTime() - CONFIG.lookbackDays * 86400 * 1000);
    const results = ((t.result || [])[0] || {}).items || [];
    let olderSeen = false;
    results.forEach(function (r) {
      const date = new Date(r.timestamp);
      if (isNaN(date) || date < cutoff) { olderSeen = true; return; }
      items.push(toRow(r, task.brand, date));
    });
    if (results.length && !olderSeen) {
      ctx.notes.push(task.brand + ': all ' + results.length + ' reviews were inside the window; raise depth in Config');
    }
  });

  if (cost) ctx.notes.push('DataForSEO cost $' + cost.toFixed(4));
  PropertiesService.getScriptProperties().setProperty(DFS_PENDING_KEY, JSON.stringify(pending));
  return { items: items.filter(Boolean) };
}

function testDataForSEO_() {
  if (!hasProps_(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])) return 'DataForSEO: no keys yet (Trustpilot and App Store skipped).';
  const ctx = newCtx_('DataForSEO');
  const json = fetchJson_(DFS_API + 'appendix/user_data', { headers: { Authorization: dfsAuth_() } }, ctx);
  const result = (((json.tasks || [])[0] || {}).result || [])[0] || {};
  const balance = result.money && result.money.balance;
  return 'DataForSEO (Trustpilot, App Store): OK' + (balance !== undefined ? ', account balance $' + balance : '') +
    '. Pending tasks: ' + Object.keys(dfsPending_()).length + '.';
}

function dfsAuth_() {
  return 'Basic ' + Utilities.base64Encode(prop_('DATAFORSEO_LOGIN') + ':' + prop_('DATAFORSEO_PASSWORD'));
}

function dfsPending_() {
  try { return JSON.parse(prop_(DFS_PENDING_KEY) || '{}'); } catch (e) { return {}; }
}
