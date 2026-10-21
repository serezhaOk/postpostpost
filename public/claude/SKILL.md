---
name: postpostpost
description: Schedule and publish short videos (Reels, Shorts, TikTok, X) through the user's postpostpost server. Use when the user asks to schedule, post, queue or publish videos to social networks, to check what is queued or published, or to change the posting schedule.
---

# postpostpost

The user runs their own postpostpost server. It publishes videos to YouTube Shorts, Instagram Reels, TikTok and X at scheduled times.
You control it through the CLI that sits next to this file:

```bash
node ~/.claude/skills/postpostpost/ppp.mjs <command>
```

Every command prints JSON with `"ok": true` or `"ok": false` and an `error`.
Node.js 20+ is required. If `node` is missing, tell the user to install it from nodejs.org.

## Commands

| Command | What it does |
|---|---|
| `status` | Connected platforms, timezone, daily slots, next free slot, and every post with per-platform status |
| `settings --slots 15:00 --tz Europe/Lisbon` | Set the daily posting times (comma-separated) and the timezone. Both flags are optional |
| `post <file> --caption "…" --at "2026-10-22 15:00" --tz Europe/Lisbon` | Upload one video and schedule it |
| `now <id>` / `retry <id>` / `delete <id>` | Publish a queued post now / retry failed platforms / remove a post |

`post` options:
- `--caption "text"` or `--caption-file path`. For YouTube, the first line of the caption becomes the title, so put the hook first.
- `--at`: `slot` (the next free daily slot; this is the default), `now`, or a local time `"YYYY-MM-DD HH:MM"`, interpreted in `--tz`. Without `--tz`, the server's timezone is used.
- `--platforms youtube,instagram,tiktok,x` — defaults to every connected platform.

## Scheduling a batch of videos

A typical request is "schedule every video in this folder with the captions from the document next to it, one a day at 15:00 Portugal time". Do it like this:

1. Run `status`. Check which platforms are connected and what is already queued, so you don't double-book a day or upload a video twice.
2. List the video files in the folder (`.mp4`, `.mov`, `.m4v`, `.webm`) and read the captions document. It may be `.txt`, `.md`, `.docx` or another format; use whatever tool reads it.
3. Match each caption to its video: by file name, by number, by order, or by a heading that mentions the video. If any match is ambiguous, ask the user. Never guess silently.
4. Work out the dates. For "Portugal" use `Europe/Lisbon` (mainland). Start from the first day whose 15:00 is still in the future and has no queued post. Go one video per day in a sensible order (file-name order, unless the document implies another).
5. **Show the plan as a table** (date and time, file, first line of the caption, platforms) and ask the user to confirm before uploading anything.
6. After confirmation, run `post` once per video with an explicit `--at` and `--tz`. Do them one at a time, because uploads can be large. If one fails, report it and continue with the rest.
7. Finish with `status` and a short summary: what was scheduled and when, and anything that failed.

If the user wants this time to be the regular schedule, also run `settings --slots 15:00 --tz Europe/Lisbon`. Videos added later from the phone then land in the same daily slot.

## Notes

- **Statuses:** `pending` (waiting), `running` / `processing` (uploading), `done`, `draft` (sitting in TikTok's inbox, and the user must tap Publish in the TikTok app), `failed` (error text included).
- **Platform limits:**
  - YouTube uploads stay private until the user's Google project passes the YouTube API audit.
  - TikTok sends videos to the inbox until its own app audit is approved.
- Captions: Instagram allows up to 2200 characters; X truncates to 280.
- If you get "Нужен вход" or a 401, the API key was revoked. Ask the user to create a new one in the app's Settings → «Claude».
