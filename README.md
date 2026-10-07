# Player Feedback Digest

A personal, non-commercial proof of concept: turning public player feedback from online gaming communities into a short weekly summary of recurring themes, with every finding traceable to its source.

This repository holds the **collector**: a small Google Apps Script that gathers public posts once a week into a private Google Sheet. Classification and the weekly summary happen in a separate step.

## How it works

```
Public sources ──► Collector (this repo, weekly) ──► Private Google Sheet ──► AI classification ──► Weekly summary
                   Google Apps Script                "Raw" tab                topic, sentiment,      themes + evidence
                                                                              severity
```

| Source | Access | Status |
|---|---|---|
| Reddit | Official Data API, read-only, application-only OAuth | Awaiting API approval |
| Review sites and app stores | Third-party APIs / public feeds | Planned |
| YouTube comments | YouTube Data API | Planned |

## Reddit data handling

The Reddit collector is designed to stay well inside Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) and Data API terms.

- **Read-only.** No posting, commenting, voting or messaging. No bot account. Application-only OAuth, so no user account acts on Reddit.
- **Small and slow.** One run a week, a hard cap of 90 requests per run, and a 1-second pause between requests.
- **Narrow scope.** New posts from two subreddits plus a keyword search, filtered to a few configured topics. See `src/Config.gs`.
- **No usernames.** Authors are never stored. `u/` mentions and email addresses in text are redacted before saving.
- **Minimal fields.** Text, score, date and permalink only.
- **90-day retention.** Rows are deleted 90 days after collection.
- **Deletions respected.** Each run re-checks stored items and deletes any that have been deleted or removed on Reddit.
- **No training.** Text is categorised by topic and sentiment using an AI model via API, for classification only. Reddit content is never used to train or fine-tune a model.
- **No profiling.** The analysis describes what posts are about, not who wrote them. No attempt is made to infer characteristics of users, and the sensitive-signal check used for other sources is switched off for Reddit data (`welfare_check = N`).
- **Not redistributed.** Output is a private summary. Reddit content is not published, sold, licensed or shared.

## Files

| File | Purpose |
|---|---|
| `src/Config.gs` | What to collect: subreddits, search terms, topic keywords, limits |
| `src/Collector.gs` | The collector: auth, collection, redaction, retention, deletion sync, run log |
| `src/appsscript.json` | Apps Script manifest (time zone, minimal permissions) |

## Setup

1. Open the Google Sheet, then **Extensions → Apps Script**.
2. Create two script files, `Config.gs` and `Collector.gs`, and paste in the contents from `src/`.
3. Optional: in **Project Settings**, tick "Show appsscript.json manifest file" and paste in `src/appsscript.json` to limit the script's permissions.
4. In **Project Settings → Script properties**, add `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `REDDIT_USERNAME`.
5. Run `testConnection` to check access. On first run, Google asks you to authorise the script.
6. Run `runWeekly` once by hand, then `setupWeeklyTrigger` to schedule it for Monday mornings.

Each run writes a line to the **Run log** tab: requests made, rows added, rows removed and any errors.

**Note:** the collector rewrites the **Raw** tab when it removes rows, so add labels and analysis in a separate tab, not as extra columns in Raw.

## Status

Early proof of concept (v0.2). The analysis method was first validated by hand on a 45-item sample before automating collection.
