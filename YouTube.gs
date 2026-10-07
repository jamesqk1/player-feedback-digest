/**
 * YouTube source: comments on recent videos about each brand, via the YouTube Data API (API key, read-only).
 * Quota: each brand search costs 100 units; each comment page costs 1 unit (daily free quota is 10,000).
 * Commenter names and channel IDs are never stored, and comments by the video's own creator are skipped.
 * Rows are kept for 30 days (CONFIG.retentionDays.YouTube), in line with YouTube's API data-storage rules.
 * Skipped until YOUTUBE_API_KEY is set.
 */

const YT_BASE = 'https://www.googleapis.com/youtube/v3/';

function runYouTube_(sheet, ctx) {
  if (!CONFIG.youtube.enabled) { ctx.notes.push('disabled in Config'); return {}; }
  if (!hasProps_(['YOUTUBE_API_KEY'])) {
    ctx.notes.push('skipped: no YouTube API key yet');
    return {};
  }
  const cutoff = lookbackCutoff_();
  const publishedAfter = new Date(Date.now() - CONFIG.youtube.videoWindowDays * 86400 * 1000).toISOString();
  const items = [];
  const seenVideos = {};

  CONFIG.brands.filter(function (b) { return b.youtubeQuery; }).forEach(function (brand) {
    let videos;
    try {
      videos = ytGet_('search', {
        part: 'snippet', q: brand.youtubeQuery, type: 'video', order: 'relevance',
        publishedAfter: publishedAfter, maxResults: CONFIG.youtube.videosPerBrand,
      }, ctx).items || [];
    } catch (e) {
      ctx.notes.push(brand.name + ' search: ' + errorText_(e));
      return;
    }

    videos.forEach(function (v) {
      const videoId = v.id && v.id.videoId;
      if (!videoId || seenVideos[videoId]) return;
      seenVideos[videoId] = true;
      const title = ytDecode_((v.snippet && v.snippet.title) || '');
      const channelTitle = ytDecode_((v.snippet && v.snippet.channelTitle) || '');
      const creatorChannel = v.snippet && v.snippet.channelId;
      // Brand from the video title or channel name. If neither names a brand, a comment is kept only
      // when the comment itself names one (search results often include loosely related videos).
      const videoBrand = detectBrand_(title + ' ' + channelTitle);
      let skippedOffTopic = 0;

      let threads;
      try {
        threads = ytGet_('commentThreads', {
          part: 'snippet', videoId: videoId, order: 'time', textFormat: 'plainText',
          maxResults: Math.min(100, CONFIG.youtube.maxCommentsPerVideo),
        }, ctx).items || [];
      } catch (e) {
        if (e.code === 403) return; // comments disabled on this video
        ctx.notes.push('video ' + videoId + ': ' + errorText_(e));
        return;
      }

      threads.forEach(function (th) {
        const c = th.snippet && th.snippet.topLevelComment;
        const s = c && c.snippet;
        if (!s) return;
        const date = new Date(s.publishedAt);
        if (date < cutoff) return;
        if (s.authorChannelId && s.authorChannelId.value === creatorChannel) return; // creator's own comment
        const commentBrand = detectBrand_(s.textOriginal) || videoBrand;
        if (!commentBrand) { skippedOffTopic++; return; }
        items.push(makeRow_({
          id: 'youtube:' + c.id,
          source: 'YouTube',
          channel: ytTrim_(title, 80),
          brand: commentBrand,
          kind: 'comment',
          date: date,
          url: 'https://www.youtube.com/watch?v=' + videoId + '&lc=' + c.id,
          score: s.likeCount,
          text: s.textOriginal,
        }));
      });
      if (skippedOffTopic) {
        ctx.notes.push(skippedOffTopic + ' comments skipped on "' + ytTrim_(title, 40) + '" (no brand in title, channel or comment)');
      }
    });
  });
  return { items: items.filter(Boolean) };
}

function testYouTube_() {
  if (!hasProps_(['YOUTUBE_API_KEY'])) return 'YouTube: no API key yet (skipped).';
  const ctx = newCtx_('YouTube');
  // videos.list costs 1 unit, unlike search (100)
  const json = ytGet_('videos', { part: 'id', chart: 'mostPopular', maxResults: 1, regionCode: 'US' }, ctx);
  return 'YouTube: OK, API key works (' + ((json.items || []).length) + ' test result).';
}

function ytGet_(endpoint, params, ctx) {
  const q = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return fetchJson_(YT_BASE + endpoint + '?' + q + '&key=' + encodeURIComponent(prop_('YOUTUBE_API_KEY')), {}, ctx);
}

/** Search results return HTML-escaped titles (&amp;, &#39;); turn them back into plain text. */
function ytDecode_(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function ytTrim_(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
