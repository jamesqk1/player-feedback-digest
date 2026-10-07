/**
 * Reddit source. Read-only, application-only OAuth (no account acts on Reddit).
 * Skipped until REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set.
 * Rows are re-checked each run and deleted if the post or comment was deleted or removed on Reddit.
 * welfare_check is always N: Reddit's policy bans inferring sensitive characteristics about users.
 */

const REDDIT_REMOVED_MARKERS = ['[deleted]', '[removed]'];

function runReddit_(sheet, ctx) {
  if (!CONFIG.reddit.enabled) { ctx.notes.push('disabled in Config'); return {}; }
  if (!hasProps_(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'])) {
    ctx.notes.push('skipped: no Reddit API keys yet');
    return {};
  }
  const token = redditToken_(ctx);
  const removedDeleted = redditSyncDeletions_(sheet, token, ctx);
  return { items: redditCollect_(token, ctx), removedDeleted: removedDeleted };
}

function testReddit_() {
  if (!hasProps_(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'])) return 'Reddit: no API keys yet (skipped).';
  const ctx = newCtx_('Reddit');
  const token = redditToken_(ctx);
  const sub = CONFIG.reddit.subreddits[0].name;
  const listing = redditGet_('/r/' + sub + '/new', { limit: 5, raw_json: 1 }, token, ctx);
  return 'Reddit: OK, read ' + redditChildren_(listing).length + ' recent posts from r/' + sub + '.';
}

/* ---------- API ---------- */

function redditToken_(ctx) {
  const auth = Utilities.base64Encode(prop_('REDDIT_CLIENT_ID') + ':' + prop_('REDDIT_CLIENT_SECRET'));
  const json = fetchJson_('https://www.reddit.com/api/v1/access_token', {
    method: 'post',
    payload: { grant_type: 'client_credentials' },
    headers: { Authorization: 'Basic ' + auth, 'User-Agent': redditUserAgent_() },
  }, ctx);
  return json.access_token;
}

function redditUserAgent_() {
  return 'google-apps-script:player-feedback-digest:v0.4 (by /u/' + (prop_('REDDIT_USERNAME') || 'unknown') + ')';
}

/** GET from the OAuth API. Returns null once the request cap is reached. */
function redditGet_(path, params, token, ctx) {
  if (ctx.requests >= CONFIG.reddit.maxRequestsPerRun) {
    const msg = 'request cap reached (' + CONFIG.reddit.maxRequestsPerRun + '); remaining calls skipped';
    if (ctx.notes.indexOf(msg) === -1) ctx.notes.push(msg);
    return null;
  }
  const query = Object.keys(params || {})
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  Utilities.sleep(CONFIG.reddit.requestDelayMs);
  return fetchJson_('https://oauth.reddit.com' + path + (query ? '?' + query : ''), {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': redditUserAgent_() },
  }, ctx);
}

/** Like redditGet_, but records the error and returns null so one failed call doesn't stop the run. */
function redditSafeGet_(path, params, token, ctx) {
  try {
    return redditGet_(path, params, token, ctx);
  } catch (e) {
    ctx.notes.push(errorText_(e));
    return null;
  }
}

function redditChildren_(listing) {
  if (!listing || !listing.data || !listing.data.children) return [];
  return listing.data.children.map(function (c) { return c.data; });
}

/* ---------- Collection ---------- */

function redditCollect_(token, ctx) {
  const cutoff = lookbackCutoff_().getTime() / 1000;
  const posts = {}; // fullname -> { p, brand }

  CONFIG.reddit.subreddits.forEach(function (sub) {
    const listing = redditSafeGet_('/r/' + sub.name + '/new', { limit: 100, raw_json: 1 }, token, ctx);
    redditChildren_(listing).forEach(function (p) {
      if (p.created_utc < cutoff || redditSkip_(p)) return;
      const brand = detectBrand_(redditPostText_(p)) || sub.defaultBrand;
      if (brand) posts[p.name] = { p: p, brand: brand };
    });
  });

  CONFIG.reddit.searchQueries.forEach(function (q) {
    const listing = redditSafeGet_('/search',
      { q: q, sort: 'new', t: 'month', limit: 100, type: 'link', raw_json: 1 }, token, ctx);
    redditChildren_(listing).forEach(function (p) {
      if (posts[p.name] || p.created_utc < cutoff || redditSkip_(p)) return;
      const brand = detectBrand_(redditPostText_(p)); // search matches loosely, so require a keyword
      if (brand) posts[p.name] = { p: p, brand: brand };
    });
  });

  const items = [];
  const entries = Object.keys(posts).map(function (k) { return posts[k]; });

  entries.forEach(function (e) {
    items.push(redditRow_(e.p, 'post', e.brand, redditPostText_(e.p), e.p.subreddit));
  });

  entries
    .filter(function (e) { return e.p.num_comments > 0; })
    .sort(function (a, b) { return b.p.num_comments - a.p.num_comments; })
    .slice(0, CONFIG.reddit.maxPostsForComments)
    .forEach(function (e) {
      const data = redditSafeGet_('/comments/' + e.p.id,
        { limit: CONFIG.reddit.maxCommentsPerPost, depth: 3, sort: 'new', raw_json: 1 }, token, ctx);
      if (!data || !data[1]) return;
      redditFlatten_(data[1]).forEach(function (c) {
        if (c.created_utc < cutoff || redditSkip_(c)) return;
        items.push(redditRow_(c, 'comment', detectBrand_(c.body) || e.brand, c.body, e.p.subreddit));
      });
    });

  return items.filter(Boolean);
}

function redditRow_(thing, kind, brand, text, subreddit) {
  return makeRow_({
    id: 'reddit:' + thing.name,
    source: 'Reddit',
    channel: 'r/' + (subreddit || thing.subreddit),
    brand: brand,
    kind: kind,
    date: new Date(thing.created_utc * 1000),
    url: 'https://www.reddit.com' + thing.permalink,
    score: thing.score,
    text: text,
    welfare: false,
  });
}

function redditPostText_(p) {
  return [p.title || '', p.selftext || ''].join('\n\n').trim();
}

/** Skip mod/bot posts and anything deleted or removed. Author is checked here but never stored. */
function redditSkip_(t) {
  if (t.stickied || t.distinguished || t.author === 'AutoModerator') return true;
  return redditIsGone_(t);
}

function redditIsGone_(t) {
  if (t.removed_by_category) return true;
  if (t.author === '[deleted]') return true;
  const body = (t.name && t.name.indexOf('t1_') === 0) ? t.body : t.selftext;
  return REDDIT_REMOVED_MARKERS.indexOf((body || '').trim()) !== -1;
}

function redditFlatten_(listing) {
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

/* ---------- Deletion sync ---------- */

function redditSyncDeletions_(sheet, token, ctx) {
  const ids = dataRows_(sheet)
    .filter(function (r) { return r[COL.source] === 'Reddit'; })
    .map(function (r) { return String(r[COL.item_id]).replace(/^reddit:/, ''); });
  if (!ids.length) return 0;

  const gone = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = redditSafeGet_('/api/info', { id: batch.join(','), raw_json: 1 }, token, ctx);
    if (!res) continue; // unknown status: keep the rows rather than guess
    const alive = {};
    redditChildren_(res).forEach(function (t) { if (!redditIsGone_(t)) alive[t.name] = true; });
    batch.forEach(function (id) { if (!alive[id]) gone['reddit:' + id] = true; });
  }
  return rewriteRows_(sheet, function (row) {
    return !(row[COL.source] === 'Reddit' && gone[String(row[COL.item_id])]);
  });
}
