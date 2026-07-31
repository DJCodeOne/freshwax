@echo off
REM FreshWax: auto-fill any release track durations that came through empty.
REM Duration extraction needs ffprobe (ffmpeg) which the Cloudflare Worker
REM cannot run, so this runs on a schedule on this machine. Idempotent:
REM a no-op when every track already has a duration. Registered as the
REM "FreshWax-DurationBackfill" scheduled task (every 15 min).
cd /d "C:\Users\Owner\freshwax"
"C:\Program Files\nodejs\node.exe" scripts\backfill-track-durations.cjs --apply > "C:\Users\Owner\freshwax\scripts\duration-backfill.last.log" 2>&1
