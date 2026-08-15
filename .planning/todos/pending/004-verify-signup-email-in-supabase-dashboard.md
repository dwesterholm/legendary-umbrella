---
title: "Verify whether the signup confirmation mail was ever sent (Supabase dashboard checks)"
status: pending
priority: P2
source: "captured 2026-08-11 — operator signed up daniel.p.westerholm+1@gmail.com once, received nothing"
created: 2026-08-11
theme: auth
area: infra
blocks: "003 (can't pick the right fix until we know whether the send happened)"
---

## Goal

Settle whether the confirmation mail was **never sent** or **sent and lost**. These are dashboard/service-role checks — not doable from the repo, which carries only the publishable key.

## Already ruled out (client-side, 2026-08-11)

Read from `GET /auth/v1/settings`:

- `disable_signup: false` — signups are on
- `mailer_autoconfirm: false` — confirmation IS required, so a send should have been attempted
- Rate limiting — operator signed up exactly once
- Already-registered address — a fresh alias was used

## The checks

1. **Authentication → Users** — is there a row for `daniel.p.westerholm+1@gmail.com`, and is `email_confirmed_at` null?
   - Row exists → signup worked; this is purely a deliverability problem, fix via SMTP (todo 003).
   - No row → something rejected the signup before sending; investigate auth logs and the client error path (`signup/page.tsx` swallows the real `signUpError`).
2. **Logs → Auth** — was the send attempted, and did it error?
3. **Inbox check** — the address is a Gmail **plus-alias**, so mail lands in the `daniel.p.westerholm@gmail.com` base inbox. Check that inbox and its spam folder, plus any filter matching the `+1` pattern. Supabase's default sender (`noreply@mail.app.supabase.io`) is routinely spam-filed by Gmail.

## Context worth carrying

The project was paused until shortly before this signup and was restored 2026-08-11 — worth ruling out a lingering auth-service issue from the restore if checks 1 and 2 both look clean.
