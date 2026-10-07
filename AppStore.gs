/**
 * App Store source: Apple's public customer-reviews feed (no keys needed).
 * Newest first, 50 reviews per page, up to 10 pages. Stops once reviews are older than the lookback window.
 * Reviewer nicknames are never stored. Apple gives no per-review link, so url points to the app's reviews page
 * and item_id holds Apple's review ID.
 */

function runAppStore_(sheet, ctx) {
  if (!CONFIG.appStore.enabled) { ctx.notes.push('disabled in Config'); return {}; }
  const cutoff = lookbackCutoff_();
  const items = [];

  CONFIG.brands.filter(function (b) { return b.appStoreId; }).forEach(function (brand) {
    for (let page = 1; page <= CONFIG.appStore.maxPages; page++) {
      let reviews;
      try {
        reviews = appStoreFetchPage_(brand.appStoreId, page, ctx);
      } catch (e) {
        ctx.notes.push(brand.name + ' page ' + page + ': ' + errorText_(e));
        break;
      }
      if (!reviews.length) break;
      let reachedOld = false;
      reviews.forEach(function (r) {
        const date = new Date(r.updated);
        if (date < cutoff) { reachedOld = true; return; }
        items.push(makeRow_({
          id: 'appstore:' + r.id,
          source: 'App Store',
          channel: CONFIG.appStore.country.toUpperCase() + ' app v' + r.version,
          brand: brand.name,
          kind: 'review',
          date: date,
          url: 'https://apps.apple.com/' + CONFIG.appStore.country + '/app/id' + brand.appStoreId + '?see-all=reviews',
          rating: r.rating,
          score: r.votes,
          text: [r.title, r.content].join('\n\n'),
        }));
      });
      if (reachedOld) break;
      if (page === CONFIG.appStore.maxPages) {
        ctx.notes.push(brand.name + ': hit maxPages before the lookback window ended; raise appStore.maxPages');
      }
    }
  });
  return { items: items.filter(Boolean) };
}

function testAppStore_() {
  const ctx = newCtx_('App Store');
  const brand = CONFIG.brands.filter(function (b) { return b.appStoreId; })[0];
  if (!brand) return 'App Store: no brands with appStoreId.';
  const reviews = appStoreFetchPage_(brand.appStoreId, 1, ctx);
  return 'App Store: OK, ' + reviews.length + ' recent reviews for ' + brand.name +
    (reviews.length ? ' (newest ' + reviews[0].updated.slice(0, 10) + ')' : '') + '.';
}

/** One page of reviews as plain objects. Retries once with an alternative URL form (the feed is occasionally flaky). */
function appStoreFetchPage_(appId, page, ctx) {
  const c = CONFIG.appStore.country;
  const urls = [
    'https://itunes.apple.com/' + c + '/rss/customerreviews/page=' + page + '/id=' + appId + '/sortby=mostrecent/json',
    'https://itunes.apple.com/' + c + '/rss/customerreviews/id=' + appId + '/page=' + page + '/sortby=mostrecent/json',
  ];
  let json = null;
  let lastErr = null;
  for (let i = 0; i < urls.length && !json; i++) {
    try { json = fetchJson_(urls[i], {}, ctx); } catch (e) { lastErr = e; }
  }
  if (!json) throw lastErr;
  let entries = (json.feed && json.feed.entry) || [];
  if (!Array.isArray(entries)) entries = [entries];
  return entries
    .filter(function (e) { return e['im:rating']; }) // the first entry is sometimes app info, not a review
    .map(function (e) {
      return {
        id: e.id.label,
        rating: Number(e['im:rating'].label),
        title: (e.title && e.title.label) || '',
        content: (e.content && e.content.label) || '',
        updated: e.updated.label,
        version: (e['im:version'] && e['im:version'].label) || '',
        votes: e['im:voteSum'] ? Number(e['im:voteSum'].label) : '',
      };
    });
}
