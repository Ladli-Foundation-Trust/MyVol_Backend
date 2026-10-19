# Auth decisions

Each entry: what we decided, why, and what we gave up. Newest work is at the top.
"Phase 2" = the first auth pass (2026-10-15). "Phase 2b" = completing auth for a social app (2026-10-17).

---

## Phase 2b — completing auth for a social app (2026-10-17)

### D1. Sessions are first-class rows (`sessions` table)
**Decision.** Every login creates a `Session` (device name, user agent, IP, last used, revoked at/why).
Refresh tokens belong to a session; access tokens carry its id as `sid`.
**Why.** A social app needs "Where you're logged in" and "Log out this device" (both are in the app's
Accounts Center). The old design grouped tokens by an anonymous `family_id`, which has no place for
device info. A session row also makes "revoke this device" a single UPDATE.
**Trade-off.** One more table. Old refresh tokens could not be mapped to sessions, so the migration
deletes them (existing dev logins had to sign in again once).

### D2. `protect` checks the session in the database on every request
**Decision.** After verifying the JWT, `protect` loads the session and user in one indexed query
and rejects revoked sessions, inactive users and mismatched users. Role comes from the DB, not the token.
**Why.** Pure stateless JWTs stay valid until they expire (15 min). On a social app that means a banned
spammer keeps posting, a stolen phone stays logged in after "log out this device", and a demoted moderator
keeps powers. One primary-key lookup is cheap compared with that.
**Trade-off.** One DB query per authenticated request. If that ever matters, cache the session check in
Redis for a few seconds.
**Replaced.** `users.token_version` (Phase 2). Revoking sessions now covers every case it handled, so the
column was dropped: one mechanism instead of two.

### D3. Refresh tokens are single-use; reuse revokes the session
**Decision.** Each refresh marks the token `used_at` and issues a new one. Presenting a used token again
revokes the whole session and writes a `refresh_token_reuse` audit event. Concurrent refreshes with the
same token are settled by a conditional UPDATE (only one wins).
**Why.** OAuth 2.0 Security BCP. If a token is copied, the thief and the real user end up racing; the second
use reveals the theft and both are logged out of that device. Without it, a stolen refresh token works for 30 days.
**Trade-off.** The app **must** single-flight refreshes: one refresh in progress, all other 401
`TOKEN_EXPIRED` requests wait for it. Two parallel refreshes would log the user out. No "grace window" was
added because it weakens detection.
Used tokens are kept 7 days (cleanup job) so late replays are still caught.

### D4. Max 10 live sessions per user
**Decision.** On login, sessions beyond `MAX_SESSIONS_PER_USER` (least recently used first) are revoked.
**Why.** Bounds table growth and the blast radius of credential-stuffing bots that log in repeatedly.
10 covers phone + tablet + browsers comfortably.


### D5. Email verification by 6-digit code, required only for publishing
**Decision.** Signup sends a code. Users can log in and browse unverified. Routes that create content
or contact people must add the `requireVerifiedEmail` middleware (403 `EMAIL_NOT_VERIFIED`).
**Why.** Blocking login until verification loses many sign-ups (mail delays, typos). Gating only
*publishing* still stops throwaway/bot accounts from spamming, which is the real risk on a social app.
Codes instead of links: the app has no deep-link email handling yet, and codes work on any device.
**Trade-off.** Unverified accounts exist. They can be purged later if they pile up.

### D6. One `verification_codes` table for every code purpose
**Decision.** `EMAIL_VERIFICATION`, `PASSWORD_RESET`, `EMAIL_CHANGE` share one table with a `purpose`
column and an optional `target` (the new email). Replaced `password_reset_tokens`.
**Why.** Same rules for all three (hash, expiry, attempts, cooldown), so one implementation
(`verificationCodeService`) instead of three copies.

### D7. Code security: HMAC with scope, 5 tries, 60 s cooldown, 5 codes/hour
**Decision.** Codes are stored as `HMAC(OTP_SECRET, purpose:userId:code)`. Each code allows 5 wrong
guesses; a new code needs 60 s; at most 5 codes per hour per purpose. Re-issuing expires older codes
instead of deleting them, so the hourly cap can count them.
**Why.** A 6-digit code has 1,000,000 values. Plain SHA-256 could be brute-forced offline in milliseconds
after a DB leak, so the secret key matters. The scope makes a code useless for another user or purpose.
The caps limit online guessing to 25 guesses per hour, about a 0.06 % chance per day.
The attempt counter is written **outside** the transaction so it can't be rolled back.

### D8. Account lockout with exponential backoff (in addition to IP rate limits)
**Decision.** Every 5th consecutive failed login locks the account: 15 min, then 30, 60, ... up to 24 h.
A successful login or password reset clears it.
**Why.** IP rate limits don't stop a botnet trying one account from thousands of IPs. Per-account lockout does.
**Trade-off.** Someone can lock another person out by failing on purpose. That's why locks are temporary,
and a password reset (which proves inbox ownership) unlocks immediately. The "locked" response reveals the
account exists. That was accepted because usernames are public on a social app anyway.

### D9. Login by email **or** username
**Decision.** `POST /login` takes `identifier`. If it contains `@` it's an email, otherwise a username.
**Why.** Standard on social apps (Instagram, X). Both are unique and lower-cased.
**Note.** The request field changed from `email` to `identifier` (the app isn't wired to the API yet).

### D10. Generic responses where they prevent account discovery
**Decision.** Login says "Incorrect email/username or password" for both unknown users and wrong
passwords, and runs a dummy argon2 verify for unknown users so timing matches. Forgot-password always
says "If an account exists...". Mail is sent fire-and-forget so response time doesn't reveal it either.
**Accepted leak.** Signup returns 409 for a taken email or username. Every social app does this (users need
to know why signup failed), and the signup rate limit slows down bulk probing.

### D11. Google sign-in, with account-linking rules
**Decision.** `POST /auth/google` verifies the Google **ID token** on the server (signature, expiry, issuer,
audience = our client IDs) using `google-auth-library`. Then:
1. Google account already linked → log in.
2. A user with that email exists → link Google to it.
3. Otherwise create a new user (email pre-verified, no password).
**Why.** The app already shows "Continue with Google". Verifying the ID token on the server is the only
safe way. Profile data sent by the app could be forged.
Accounts are linked by email only when Google says `email_verified`.

### D12. Pre-account-takeover defence when linking
**Decision.** If Google links to an existing account whose email was **never verified**, that account's
password is cleared and its sessions are revoked.
**Why.** Classic attack: someone signs up with the victim's email and a password they know, then waits
for the victim to "Sign in with Google" into the same account. Google has just proved who owns the inbox,
so the unverified password (possibly the attacker's) is removed.

### D13. Google sign-up asks for missing details instead of guessing them
**Decision.** For a brand-new Google user without `dateOfBirth`/`acceptTerms`, the API returns
400 `PROFILE_REQUIRED` with the missing fields. The app shows a short form and calls again with the same
ID token (valid ~1 h). The username is auto-generated from the email if not given.
**Why.** The age gate and terms consent must apply to every account, and Google doesn't give us a birth date.
Not storing state between the two calls keeps the server simple.

### D14. Age gate (13+) and timestamped terms consent
**Decision.** Signup requires `dateOfBirth` (age ≥ `MIN_SIGNUP_AGE`, default 13) and `acceptTerms: true`.
`terms_accepted_at` is stored.
**Why.** Social platforms must not knowingly onboard children under 13 (COPPA, and app store
policies). The timestamp is evidence of consent.
**Open question for the org.** India's DPDP Act 2023 treats under-18s as children and requires
*verifiable parental consent*. Either set `MIN_SIGNUP_AGE=18` or build a parental-consent flow before launch.
This is a legal decision, not a technical one.

### D15. Re-authentication for sensitive actions
**Decision.** Email change, deactivation and deletion require the current password. Changing a password
requires the current one. Google-only users (no password) must instead have signed in within the last
`REAUTH_WINDOW_MINUTES` (10).
**Why.** An unlocked phone or a stolen access token must not be enough to take over or destroy an account.
These endpoints are also rate-limited per user, so they can't be used to guess the password.

### D16. 401 means only "your session is dead"
**Decision.** A wrong password on an authenticated route returns **403** `INVALID_PASSWORD` /
`REAUTH_REQUIRED`, not 401. Every error carries a machine-readable `code`.
**Why.** Mobile clients usually treat any 401 as "refresh, then log out". A typo in the "confirm password"
box must not log the user out. `code` lets the app tell `TOKEN_EXPIRED` (refresh) apart from
`SESSION_INVALID` (log out) without parsing messages.

### D17. Email change is confirmed from the new inbox; the old inbox is told
**Decision.** Two steps: `/email/change` (password + new email → code sent to the **new** address), then
`/email/change/confirm`. On success the old address gets a notice and other devices are signed out.
**Why.** Changing the email is the classic way to take over an account permanently. Proving the new inbox
stops typos and hijacks. Telling the old inbox gives the real owner a chance to react. The app's FAQ
already promises "changes to your email need to be confirmed from the new inbox".

### D18. Password change keeps this device, signs out the others; reset signs out everything
**Decision.** `change-password` revokes every session except the current one and returns the user (no new
tokens needed). `reset-password` revokes all sessions. Both send a "password changed" email.
**Why.** On change, the user is clearly holding this device, so logging them out would be annoying.
On reset we don't know which devices the attacker holds, so all are logged out.

### D19. Deactivate vs delete (soft delete with a 30-day grace period)
**Decision.** Account status is one enum: `ACTIVE | DEACTIVATED | PENDING_DELETION | SUSPENDED`.
- Deactivate → hidden, all sessions revoked; logging in reactivates.
- Delete → `PENDING_DELETION` + `deletion_scheduled_at = now + 30 d`; logging in cancels; after the date
  the cleanup job hard-deletes the user, and `ON DELETE CASCADE` removes everything they own.
- Suspended (moderation) → cannot log in. The 403 is shown only **after** a correct password, so it
  doesn't reveal which accounts are banned.
**Why.** This matches the app's FAQ text and common practice (Instagram, X). The grace period protects
against regret and against an attacker deleting the account. Hard delete at the end supports
"right to erasure" (DPDP/GDPR).
**Follow-up for later phases.** Every feed/profile/search query must filter `status = 'ACTIVE'`.
New tables that hold user content must use `onDelete: Cascade` (or anonymise) so the purge is complete.
`POST /account/delete` is a POST, not `DELETE /account`, because some proxies and HTTP clients drop DELETE
bodies, and the body carries the password.

### D20. Append-only audit log (`auth_events`)
**Decision.** Security-relevant actions (signup, login, failures, lockouts, token reuse, password/email
changes, linking, deactivation, deletion) are recorded with IP, user agent and small metadata. Writes are
fire-and-forget, made after the transaction commits, and kept for 180 days.
**Why.** Needed to investigate account takeovers and abuse reports, which are routine on social platforms,
and later to power "Login activity" / "new login" alerts. Fire-and-forget means logging can never break
or slow down a login.

### D21. Email through one mailer with a console fallback
**Decision.** `src/lib/mailer.js` uses nodemailer with `SMTP_URL`. Without it, mail is printed to the console
outside production and dropped (with an error log) in production. Tests capture mail in an in-memory
outbox. Emails are plain text and say what to do "if this wasn't you".
**Why.** No email provider has been chosen yet, and this keeps every flow testable end to end.
**Follow-up.** Before launch: pick a provider (SES / Postmark / Resend), set SPF/DKIM/DMARC, and move sending
onto a job queue so retries survive restarts.

### D22. Rate limits tuned for shared mobile IPs
**Decision.** A global limit of 1000 requests / 15 min per IP. Login counts only *failed* attempts (20 / 15 min).
Refresh: 100 / 15 min. Code and password-confirm actions are limited **per user** (10 / 15 min).
**Why.** Many Indian mobile users share one public IP (carrier-grade NAT), so strict per-IP limits would
block real people. Per-account defences (D7, D8) do the precise work. The IP limits only stop bulk abuse.
**Trade-off.** Counters are in memory. With more than one instance, add `rate-limit-redis`.

### D23. Username rules
**Decision.** 3–30 chars, `a-z 0-9 . _`, lower-cased, no leading/trailing/double dots, not all digits,
not reserved (`admin`, `support`, `official`, `myvolapp`, ... also matched with dots/underscores removed,
so `sup.port` is blocked too). `GET /username-available` lets the signup form check as you type.
**Why.** Prevents impersonating staff/official accounts and clashes with app routes. Lower-casing makes
uniqueness case-insensitive (`Priya` = `priya`), which stops look-alike handles.

### D24. Password policy follows NIST 800-63B
**Decision.** 8–128 chars, at least a letter and a number (kept from Phase 2), not in a common-password
blocklist, not containing the username or email name. No forced rotation, no symbol rules.
**Why.** Length and blocklists stop real attacks. Complex composition rules mostly produce `Password1!`.
**Follow-up.** Check against Have I Been Pwned's k-anonymity API (sends only 5 hash characters).
It was left out for now because it adds an external call to signup.

### D25. Cleanup job: in-process timer, advisory lock, and a script
**Decision.** `jobs/authCleanup.js` deletes expired/revoked sessions and tokens, old codes and old audit
events, and purges accounts past their deletion date. It runs at startup and every 6 h, inside one
transaction guarded by `pg_try_advisory_xact_lock`. `npm run auth:cleanup` runs it from cron.
**Why.** Without it, token tables grow forever and "delete after 30 days" never happens. The advisory lock
means several API instances can all schedule it safely: only one does the work.

### D26. Response hygiene
**Decision.** All `/auth` responses send `Cache-Control: no-store`. `toPublicUser` is the only user shape
returned. It never includes the hash, but exposes `emailVerified` and `hasPassword` so the app can show
"verify your email" / "set a password". `passwordHash` stays omitted by default at the Prisma client level.
**Why.** Tokens and personal data must never sit in a proxy or device HTTP cache. A single serializer
means a new column can't leak by accident.

### D27. Integration tests against a real, separate Postgres database
**Decision.** `node:test` + `supertest` against `myvolapp_test` (30 tests covering every flow above).
The test helper refuses to run unless the DB name ends in `_test`. Rate limiters are skipped when
`NODE_ENV=test`. Google verification is stubbed.
**Why.** Auth bugs are mostly about DB state (rotation, revocation, races, cascades), which mocks hide.
`node:test` is built in, so no extra test framework is needed.

### D28. Dependency updates
**Decision.** Added `nodemailer`, `google-auth-library`, `supertest` (dev). Prisma packages moved from
7.10.0 to **7.10.1** (still pinned) to pick up a fix for a high-severity advisory in a Prisma CLI dependency.
`npm audit --omit=dev` reports 0 vulnerabilities. The remaining advisories are in dev-only tools
(nodemon's `chokidar`/`braces`).

### Deliberately not done (yet)
| Item | Why it was deferred |
|---|---|
| Two-factor auth (TOTP + backup codes) | No UI in the app yet. Recommended before public launch, at least for staff/moderator roles. |
| Sign in with Apple | Required by App Store rules if Google sign-in ships on iOS. Android-first for now. |
| Phone number / SMS OTP login | The signup form collects a mobile number, but SMS costs money and needs a DLT-registered sender in India. |
| "New login from X" emails | Needs device fingerprinting to avoid spam. The audit log already has the data. |
| Admin suspend/unsuspend endpoints | Belongs to the moderation phase. The `SUSPENDED` status is already enforced everywhere. |
| Breached-password check (HIBP) | See D24. |
| Redis-backed rate limits | Only needed once there is more than one instance (D22). |
| CAPTCHA / Play Integrity on signup | Add if bot sign-ups show up in `auth_events`. |

---

## Phase 2 — initial auth (2026-10-15)

### P1. argon2id for passwords
OWASP's first choice: memory-hard, so GPU cracking is expensive. Unknown users still pay for a dummy
verify (see D10).

### P2. Short-lived JWT access token + opaque refresh token
15-minute HS256 JWT with pinned algorithm, issuer and audience. Only the refresh token's SHA-256 is stored.
SHA-256 (not argon2) is fine here because the token is 384 random bits and can't be brute-forced.

### P3. Refresh token in the body **and** an httpOnly cookie
The mobile app can't use cookies reliably and stores the token in SecureStore. A future web client
uses the cookie (`SameSite=Strict`, path `/api/v1/auth`, `Secure` in production), so JavaScript never sees it.

### P4. zod validation at the edge, `strictObject` for bodies
Unknown fields are rejected, which stops mass assignment such as `{ "role": "ADMIN" }` in signup.
Emails and usernames are trimmed and lower-cased before they reach the database.

### P5. Errors are `{ status, message }`
The app's `src/api/client.js` reads `message`. Phase 2b only *added* `code` (D16), so nothing breaks.
