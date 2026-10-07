/**
 * App Store source, via DataForSEO's App Data API.
 * (Apple's free public review feed returns an empty list when called from Google's servers, so it can't be used here.)
 * Posting and collecting are handled in DataForSEO.gs. Reviewer nicknames are never stored.
 * Apple gives no per-review link, so url points to the app's reviews page and item_id holds Apple's review ID.
 */

function runAppStore_(sheet, ctx) {
  return dfsCollect_('App Store', ctx, function (r, brand, date) {
    const appId = (CONFIG.brands.filter(function (b) { return b.name === brand; })[0] || {}).appStoreId;
    return makeRow_({
      id: 'appstore:' + r.id,
      source: 'App Store',
      channel: CONFIG.appStore.country.toUpperCase() + ' app v' + (r.version || '?'),
      brand: brand,
      kind: 'review',
      date: date,
      url: 'https://apps.apple.com/' + CONFIG.appStore.country + '/app/id' + appId + '?see-all=reviews',
      rating: r.rating && r.rating.value,
      text: [r.title || '', r.review_text || ''].join('\n\n'),
    });
  });
}
