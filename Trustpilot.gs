/**
 * Trustpilot source, via DataForSEO's Business Data API (a third-party provider; Trustpilot's own API is enterprise-only).
 * DataForSEO works in two steps:
 *   postTrustpilotTasks()  asks for each brand's most recent reviews (scheduled about an hour before runWeekly)
 *   runWeekly()            collects whichever tasks are ready; unfinished ones stay pending for the next run
 * Skipped until DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are set.
 * Reviewer names, profiles and locations are never stored.
 */

const DFS_BASE = 'https://api.dataforseo.com/v3/business_data/trustpilot/reviews/';
const TP_PENDING_KEY = 'TRUSTPILOT_PENDING_TASKS';

function postTrustpilotTasks() {
  const ctx = newCtx_('Trustpilot');
  if (!CONFIG.trustpilot.enabled || !hasProps_(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])) {
    console.log('Trustpilot: skipped (disabled or no DataForSEO keys).');
    return;
  }
  const brands = CONFIG.brands.filter(function (b) { return b.trustpilotDomain; });
  const payload = brands.map(function (b) {
    return { domain: b.trustpilotDomain, depth: CONFIG.trustpilot.depth, sort_by: 'recency', tag: b.name };
  });
  const json = fetchJson_(DFS_BASE + 'task_post', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { Authorization: dfsAuth_() },
  }, ctx);

  const pending = tpPending_();
  const postedAt = new Date().toISOString();
  (json.tasks || []).forEach(function (t) {
    if (t.status_code === 20100 && t.id) {
      pending[t.id] = { brand: (t.data && t.data.tag) || '', postedAt: postedAt };
    } else {
      console.error('Trustpilot task not created: ' + t.status_code + ' ' + t.status_message);
    }
  });
  PropertiesService.getScriptProperties().setProperty(TP_PENDING_KEY, JSON.stringify(pending));
  console.log('Trustpilot: ' + Object.keys(pending).length + ' task(s) pending. Run runWeekly in a few minutes to collect.');
}

function runTrustpilot_(sheet, ctx) {
  if (!CONFIG.trustpilot.enabled) { ctx.notes.push('disabled in Config'); return {}; }
  if (!hasProps_(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])) {
    ctx.notes.push('skipped: no DataForSEO keys yet');
    return {};
  }
  const pending = tpPending_();
  const ids = Object.keys(pending);
  if (!ids.length) {
    ctx.notes.push('no pending tasks: run postTrustpilotTasks first (scheduled automatically by setupWeeklyTriggers)');
    return {};
  }

  const items = [];
  ids.forEach(function (id) {
    const task = pending[id];
    let json;
    try {
      json = fetchJson_(DFS_BASE + 'task_get/' + id, { headers: { Authorization: dfsAuth_() } }, ctx);
    } catch (e) {
      ctx.notes.push(task.brand + ': ' + errorText_(e));
      return; // keep pending; try again next run
    }
    const t = (json.tasks || [])[0] || {};
    if (t.status_code === 40602 || t.status_code === 40601) {
      ctx.notes.push(task.brand + ': task still in queue, will collect next run');
      return;
    }
    delete pending[id];
    if (t.status_code !== 20000) {
      ctx.notes.push(task.brand + ': task failed (' + t.status_code + ' ' + t.status_message + ')');
      return;
    }
    const cutoff = new Date(new Date(task.postedAt).getTime() - CONFIG.lookbackDays * 86400 * 1000);
    const reviews = ((t.result || [])[0] || {}).items || [];
    let olderSeen = false;
    reviews.forEach(function (r) {
      const date = new Date(r.timestamp);
      if (isNaN(date) || date < cutoff) { olderSeen = true; return; }
      items.push(makeRow_({
        id: 'trustpilot:' + tpReviewId_(r.url),
        source: 'Trustpilot',
        channel: r.language ? 'Trustpilot (' + r.language + ')' : 'Trustpilot',
        brand: task.brand,
        kind: 'review',
        date: date,
        url: r.url,
        rating: r.rating && r.rating.value,
        score: r.rating && r.rating.votes_count,
        text: [r.title || '', r.review_text || ''].join('\n\n'),
      }));
    });
    if (reviews.length && !olderSeen) {
      ctx.notes.push(task.brand + ': all ' + reviews.length + ' reviews were inside the window; raise trustpilot.depth');
    }
  });

  PropertiesService.getScriptProperties().setProperty(TP_PENDING_KEY, JSON.stringify(pending));
  return { items: items.filter(Boolean) };
}

function testTrustpilot_() {
  if (!hasProps_(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])) return 'Trustpilot: no DataForSEO keys yet (skipped).';
  const ctx = newCtx_('Trustpilot');
  const json = fetchJson_('https://api.dataforseo.com/v3/appendix/user_data', { headers: { Authorization: dfsAuth_() } }, ctx);
  const result = (((json.tasks || [])[0] || {}).result || [])[0] || {};
  const balance = result.money && result.money.balance;
  return 'Trustpilot (DataForSEO): OK' + (balance !== undefined ? ', account balance $' + balance : '') + '. Pending tasks: ' +
    Object.keys(tpPending_()).length + '.';
}

function dfsAuth_() {
  return 'Basic ' + Utilities.base64Encode(prop_('DATAFORSEO_LOGIN') + ':' + prop_('DATAFORSEO_PASSWORD'));
}

function tpPending_() {
  try { return JSON.parse(prop_(TP_PENDING_KEY) || '{}'); } catch (e) { return {}; }
}

function tpReviewId_(url) {
  const m = /\/reviews\/([A-Za-z0-9]+)/.exec(url || '');
  return m ? m[1] : (url || '');
}
