---
title: "Signup shows 'Kolla din e-post' unconditionally and sends no emailRedirectTo — confirmation failures are invisible"
status: done
completed: 2026-08-11
priority: P1
source: "captured 2026-08-11 — operator signed up a fresh address (a Gmail plus-alias) and never received a confirmation mail; the UI still showed the success screen"
created: 2026-08-11
theme: auth
area: frontend
---

## Goal

Stop the signup flow from silently claiming success. Two separate defects in `src/app/(auth)/signup/page.tsx`, plus an open question about the mail itself.

## Defect 1 — success is unconditional

`handleSubmit` (`signup/page.tsx:31-43`) checks only `signUpError`, then sets `success = true` and renders "Kolla din e-post … Vi har skickat en bekräftelselänk". It never inspects the returned `data`.

That matters because Supabase deliberately returns **success** when the email is already registered — an anti-enumeration behavior — with `data.user.identities === []` and no mail sent. In that case the screen confidently tells the user to check an inbox that will never receive anything, and there is no path forward: no "already registered, go to login", no resend.

Fix: branch on `data.user?.identities?.length === 0` (already registered → point at login / password reset) versus a genuine new signup. Keep the message honest in both branches.

## Defect 2 — no `emailRedirectTo`

The call is a bare `supabase.auth.signUp({ email, password })` with no options, even though the confirm handler already exists at `src/app/(auth)/auth/confirm`. Without `emailRedirectTo` the link falls back to the project's configured Site URL, so a confirmation started on `localhost:3001` can land on a deployed host (or vice versa) and fail to confirm the session the user is actually waiting in.

Fix: pass `emailRedirectTo` resolved from the current origin, targeting `/auth/confirm`.

## Open question — did the mail send at all?

Ruled out from the client side on 2026-08-11 by reading `GET /auth/v1/settings`: `disable_signup: false`, `mailer_autoconfirm: false` — confirmations are required, so a genuinely-new address SHOULD have produced a send. Also ruled out: rate limiting (operator signed up exactly once).

Still unverified, and NOT checkable without dashboard/service-role access:

- Whether the user row exists and `email_confirmed_at` is null — **Authentication → Users**.
- Whether the send was attempted or errored — **Logs → Auth**.
- Gmail deliverability: the default Supabase sender (`noreply@mail.app.supabase.io`) has weak reputation and is frequently spam-filed. The address used was a Gmail **plus-alias**, which delivers to the base inbox and may additionally hit a user filter — check the base inbox and spam, not just the alias.

## Also worth doing

Supabase's built-in SMTP is rate-limited (~2/hour) and explicitly not for production. Configure custom SMTP (Resend / Postmark / SES) under **Project Settings → Authentication → SMTP** before any real user signs up. Without it this will keep failing intermittently no matter how good the client code is.

Related: the generic `setError("Nagot gick fel. Forsok igen.")` discards the actual `signUpError`, so genuine failures (rate limit, weak password, invalid address) are all indistinguishable to both the user and to anyone debugging. Worth improving in the same pass.
