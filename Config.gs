/**
 * Player Feedback Digest: collector settings.
 *
 * Edit this file to change what is collected.
 * Secrets do NOT go here. Set these in Project Settings > Script properties:
 *   REDDIT_CLIENT_ID      from your Reddit app
 *   REDDIT_CLIENT_SECRET  from your Reddit app
 *   REDDIT_USERNAME       your Reddit username (used only in the User-Agent, as Reddit requires)
 */
const CONFIG = {
  sheetName: 'Raw',          // tab the collector writes to (created if missing)
  logSheetName: 'Run log',   // one row per run: requests made, rows added and removed, errors

  lookbackDays: 8,           // weekly run plus one day of overlap; duplicates are skipped
  retentionDays: 90,         // rows collected more than this many days ago are deleted
  minWords: 10,              // skip very short posts and comments
  maxTextChars: 5000,        // truncate very long posts

  maxRequestsPerRun: 90,     // hard cap per run, including auth and deletion checks
  requestDelayMs: 1000,      // at most about 60 requests a minute, well under Reddit's free-tier limit

  // Brands are matched by keyword in the post or comment text (case-insensitive).
  brands: [
    { name: 'Chumba', keywords: ['chumba'] },
    { name: 'Crown Coins', keywords: ['crown coins', 'crowncoins'] },
    { name: 'Lavish Luck', keywords: ['lavish luck', 'lavishluck'] },
  ],

  reddit: {
    // Subreddits whose new posts are read each run.
    // defaultBrand applies when no brand keyword appears; null means keep only posts that mention a brand.
    subreddits: [
      { name: 'ChumbaCasinoPt2', defaultBrand: 'Chumba' },
      { name: 'DailyCashList', defaultBrand: null },
    ],
    // Read-only keyword search across Reddit. Only posts that match a brand keyword are kept.
    searchQueries: ['"chumba"', '"crown coins"', '"lavish luck"'],
    maxPostsForComments: 30,   // comment threads fetched per run (busiest posts first)
    maxCommentsPerPost: 50,
  },
};
