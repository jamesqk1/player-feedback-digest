# Player Feedback Digest

A personal, non-commercial proof of concept: turning public player feedback from online gaming communities into a short weekly summary of recurring themes, with every finding traceable to its source.

This repository holds the **collector**: a small Google Apps Script that gathers public reviews, posts and comments once a week into a private Google Sheet. Classification and the weekly summary happen in a separate step.

## How it works

```
Public sources ──► Collector (this repo, weekly) ──► Private Google Sheet ──► AI classification ──► Weekly summary
                   Google Apps Script                "Raw" tab                topic, sentiment,      themes + evidence
                                                                              severity
```

| Source | Access | Keys needed | Status |
|---|---|---|---|
| App Store reviews | Apple's public customer-reviews feed | None | Live |
| Trustpilot reviews | DataForSEO Business Data API (third-party provider) | DataForSEO login | Live |
| YouTube comments | YouTube Data API v3, read-only | API key | Live |
| Reddit posts and comments | Reddit Data API, read-only, application-only OAuth | Reddit app | Awaiting API approval |

A source with no keys is skipped and noted in the Run log, so sources can be switched on one at a time.

## Data handling

All sources:
- **No author data.** Reviewer, commenter and poster names, handles, profiles and locations are never stored.
- **Redaction.** Email addresses, `@handles` and `u/` mentions in text are replaced before saving.
- **Minimal fields.** Text, rating or score, date, link and the brand or topic it relates to.
- **Short text skipped.** Items under 10 words are ignored.
- **Retention.** Rows are deleted automatically after 90 days (30 days for YouTube, in line with YouTube's API data-storage rules).
- **Private.** Output is a private summary. Source content is not published, sold, licensed or shared.
- **No training.** Text is categorised by topic and sentiment using an AI model via API, for classification only. It is never used to train or fine-tune a model.

Reddit, additionally (to stay inside Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)):
- **Read-only.** No posting, commenting, voting or messaging. No bot account.
- **Small and slow.** One run a week, a hard cap of 90 requests per run, and a 1-second pause between requests.
- **Narrow scope.** New posts from two subreddits plus a keyword search. See `Config.gs`.
- **Deletions respected.** Each run re-checks stored items and deletes any that were deleted or removed on Reddit.
- **No profiling.** The analysis describes what posts are about, not who wrote them. The sensitive-signal check used for other sources is switched off for Reddit data (`welfare_check = N`).

## Files

| File | Purpose |
|---|---|
| `Config.gs` | What to collect: brands, per-source IDs, subreddits, search terms, limits, retention |
| `Collector.gs` | Entry points (`runWeekly`, `testSources`, `setupWeeklyTriggers`) and shared helpers: redaction, sheet writing, retention, run log |
| `AppStore.gs` | App Store reviews |
| `Trustpilot.gs` | Trustpilot reviews via DataForSEO (two steps: post tasks, then collect results) |
| `YouTube.gs` | YouTube comments on recent videos about each brand |
| `Reddit.gs` | Reddit posts and comments, plus deletion sync |
| `appsscript.json` | Apps Script manifest (time zone, minimal permissions) |

## Raw tab columns

`item_id`, `source`, `channel` (subreddit, app version, video title…), `brand`, `kind` (post, comment, review), `post_date`, `url`, `rating` (stars, where the source has them), `score` (upvotes, likes or helpful votes), `text`, `collected_at`, `welfare_check`.

## Setup

1. Open the Google Sheet, then **Extensions → Apps Script**.
2. Create one script file per `.gs` file in this repo, with the same names, and paste in their contents.
3. Optional: in **Project Settings**, tick "Show appsscript.json manifest file" and paste in `appsscript.json` to limit the script's permissions.
4. In **Project Settings → Script properties**, add the keys for the sources you want:
   - `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`
   - `YOUTUBE_API_KEY`
   - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`
5. Run `testSources` to check each source. On first run, Google asks you to authorise the script.
6. Run `postTrustpilotTasks`, wait a few minutes, then run `runWeekly`.
7. Run `setupWeeklyTriggers` to schedule it: `postTrustpilotTasks` around 5am and `runWeekly` around 6am every Monday.

Each run writes one line per source to the **Run log** tab: requests made, rows added, rows removed and any notes.

**Note:** the collector rewrites the **Raw** tab when it removes rows, so add labels and analysis in a separate tab, not as extra columns in Raw.

## Status

Early proof of concept (v0.3). The analysis method was first validated by hand on a 45-item sample before automating collection.
