/**
 * Trustpilot source, via DataForSEO's Business Data API (a third-party provider; Trustpilot's own API is enterprise-only).
 * Posting and collecting are handled in DataForSEO.gs. Reviewer names, profiles and locations are never stored.
 */

function runTrustpilot_(sheet, ctx) {
  return dfsCollect_('Trustpilot', ctx, function (r, brand, date) {
    return makeRow_({
      id: 'trustpilot:' + tpReviewId_(r.url),
      source: 'Trustpilot',
      channel: r.language ? 'Trustpilot (' + r.language + ')' : 'Trustpilot',
      brand: brand,
      kind: 'review',
      date: date,
      url: r.url,
      rating: r.rating && r.rating.value,
      score: r.rating && r.rating.votes_count,
      text: [r.title || '', r.review_text || ''].join('\n\n'),
      countText: r.review_text || '',   // titles often repeat the start of the review
    });
  });
}

function tpReviewId_(url) {
  const m = /\/reviews\/([A-Za-z0-9]+)/.exec(url || '');
  return m ? m[1] : (url || '');
}
