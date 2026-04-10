# DJ Bypass Granted — Email Draft

> Status: **DRAFT — not sent**. Review the subject + body below, then run
> `node scripts/send-dj-bypass-email.cjs --confirm` to send.

---

## Recipients (12 DJs)

Pulled from the recently-added `djLobbyBypass` entries created by the sync
scripts. Anyone without a valid email is skipped automatically.

| DJ | Email |
|---|---|
| Hutts | andyhutton2@yahoo.com |
| ⱤØ₭Ø (Roko) | jay.248@hotmail.co.uk |
| Parody | nyctophiliarecordings@hotmail.com |
| Dark Dusk | undergroundlair.23@gmail.com |
| Mind (UK) | *(no email on file — skip)* |
| Jase-1 | j1stephens@live.co.uk |
| JonyNo5 | jonathanwhittelsey@gmail.com |
| Madayo | a.witten@sky.com |
| Jeffrey Packard | jeffreycpackard@gmail.com |
| Mitchell Webb | mitchellwebb82@gmail.com |
| Katherina Khoury | katherinakhoury@gmail.com |
| NoLightNoShadows | paulf9970@yahoo.com |
| Radiobomb | *(no email on file — skip)* |
| Bakkus Recordings | mitchellwebb82@yahoo.co.uk |
| Underground Lair Recordings | undergroundlair.recordings@gmail.com |

---

## Subject

`You're in — full DJ access granted on Fresh Wax 👑`

## From

`Fresh Wax <noreply@freshwax.co.uk>`

## Body (plain-text preview)

```
Ez {firstName},

Quick one — you've been granted full DJ access on Fresh Wax.

All restrictions lifted — you can go live without meeting the criteria.
As a recognised DJ, your account now has full DJ privileges from day one.

What this unlocks:

  • Book live slots in the DJ Lobby and stream straight away
  • Stream from a laptop (OBS / BUTT) or directly from your phone
    — no software needed, just open the page and hit Go Live
  • Take over from another DJ mid-stream when they finish
  • Multi-stream to your own Twitch account at the same time
  • Share links ready to go the moment you're live

Get started:

  1. Sign in at https://freshwax.co.uk/login/
  2. Head to your DJ Lobby: https://freshwax.co.uk/account/dj-lobby/
  3. Book a slot, then go live when your time comes

Heads up — Fresh Wax is in its final polish phase before the full
production launch. If you spot anything broken, weird, or just plain
wrong, please reply to this email. We'd rather hear it from you than
guess.

Welcome aboard.

— Fresh Wax
```

---

## HTML version

The send script (`scripts/send-dj-bypass-email.cjs`) wraps the body in the
standard Fresh Wax email template (header, footer, CTA button) using the same
`emailWrapper()` helper as all the other transactional emails. The HTML
preview is built dynamically from the body above plus a "Open DJ Lobby" CTA
button linking to `https://freshwax.co.uk/account/dj-lobby/`.

---

## How to send

1. **Review this file** and edit any wording / recipients you want to change.
2. **Dry run** (default — does NOT send, just logs the recipient list and
   the rendered HTML for one user):
   ```
   node scripts/send-dj-bypass-email.cjs
   ```
3. **Send for real**:
   ```
   node scripts/send-dj-bypass-email.cjs --confirm
   ```

The script reads `RESEND_API_KEY` from `.env` and skips any user with no
email on file.
