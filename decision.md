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
or contact people must add the `requireVerified` middleware (403 `EMAIL_NOT_VERIFIED`). Renamed from
`requireVerifiedEmail` in D30: a phone number counts as verified too.
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

### D29. Dev-only OTP echo for Postman testing (2026-10-19)
**Decision.** `EXPOSE_OTP_IN_RESPONSE=true` adds `devOtp` to signup, resend-verification, forgot-password
and email-change responses. The default is off, the server exits at startup if it is on in production, and
`.env.test` pins it off so the tests check the real response shape. A Postman collection in `postman/`
drives every flow end to end.
**Why.** There's no email provider yet (D21). Reading codes from the server console works but interrupts
running the whole flow in Postman. The flag sits in one helper (`devOtp` in `authService`), so the
production code path does not change.
**Trade-off.** With the flag on, forgot-password reveals which emails exist. This is acceptable only for local use.

### D30. Phone sign-up and login, up to 4 accounts per number (2026-10-21)
**Decision.** Instagram-style: `phone/send-code` → `phone/verify-code` returns a `phoneToken` plus the
accounts already on the number → one of `phone/signup`, `phone/login` (SMS code, no password),
`phone/reset-password`, `phone/change`. `POST /login` also accepts a phone as `identifier`.
- The number is verified **before** the account exists, so `users.phone` is only ever a verified number
  (no `phone_verified_at` column needed). Codes live in `phone_codes`, keyed by number, not user.
- `users.phone` is not unique; `MAX_ACCOUNTS_PER_PHONE=4` is enforced inside the transaction behind a
  per-number advisory lock, so concurrent sign-ups can't create a 5th. `users.email` became nullable,
  with a CHECK that email or phone is set.
- `phoneToken` is a 15-minute JWT with its own audience (can't be used as an access token) whose `jti` is
  the code row. Using it sets `consumed_at` inside the action's transaction: single use, but a failed
  signup (e.g. username taken) rolls back and the user can retry without a new SMS.
- `send-code` with `purpose: login` answers the same whether or not the number has accounts, and only
  texts numbers that do. `signup`/`change` check the 4-account limit before any SMS is paid for.
- Phone + password with several accounts: the password picks the account (oldest first if two share one).
  To reach a specific account, log in by username or use the SMS code and pick it.
- An extra per-IP `smsLimiter` (20 per 15 min) on top of the per-number caps, against SMS-pumping fraud.
**Why 4 and why not unique.** People run a personal and a volunteer/organisation account from one phone;
Instagram allows several per number. A small cap stops one SIM farming hundreds of accounts.
**Trade-off.** Phone-only users get no security emails (they have no email); a phone change texts the
old number. Real SMS delivery is still to do (`src/lib/sms.js` is the only place to change).

### D31. Profiles: core fields on `users`, extended volunteer fields in `profiles` (2026-10-21)
**Decision.** `bio`, `avatar_key`, `is_private` and the follow counters live on `users`, because every list
row and profile header needs them. The Profile Details screen's extended fields (location, gender,
education, skills, preferred areas, availability, volunteering types, `show_personal_details`) live in an
optional 1:1 `profiles` row, created on first edit. Option lists are validated in zod, not as DB enums, so
the app can add an option without a migration. Arrays are Postgres `text[]`.
**Why.** Keeps the auth table lean and avoids a join for the common case (cards), while `GET /:user` gets
everything with one include. One `PATCH /users/me` serves the whole edit screen.

### D32. Follow graph with denormalised counters
**Decision.** `follows(follower_id, following_id)` with a composite PK and `follow_requests` for private
accounts. `followers_count`/`following_count` on users change only inside the transaction that writes the
follow row (`followService.addFollow/removeFollow`), driven by the rows actually changed
(`createMany skipDuplicates` / `deleteMany`), so double taps and races can't skew them. CHECK constraints
stop negative counts and self-follows. The cleanup job subtracts a purged user's follows before the
cascade deletes them.
**Why.** Counting on every profile view doesn't scale; counters that drift are a classic social-app bug.
**Known gap.** Deactivated users still count in other people's totals (they're hidden from the lists).
Instagram behaves similarly; revisit if users notice.

### D33. Privacy rule in one place; Instagram-like private accounts
**Decision.** `socialGraph.canView(viewer, user, followStatus)` = own, public, or approved follower. A
private profile still shows name, username, avatar, bio and counts (so people know who they're
requesting), but `details` is null and lists are 403 `PRIVATE_ACCOUNT`. Going public auto-approves pending
requests. Gender, DOB and education need `showPersonalDetails` even for followers. Inactive users are 404
everywhere. Posts, stories and comments must reuse `canView`.

### D34. Avatar upload: server-side processing, storage behind an interface
**Decision.** `PUT /users/me/avatar` (multipart). sharp checks the real format (JPEG/PNG/WebP/HEIC; SVG
refused), caps input at 40 MP, auto-rotates, crops to 512×512 WebP and strips metadata (phone photos carry
GPS). Files are stored under random keys via `lib/storage.js` (local disk, served at `/uploads`); the DB
stores the key and URLs are built at read time from `PUBLIC_BASE_URL`. `sharp` is ^0.35.5 because older
versions carry high-severity libvips advisories.
**Why not signed direct-to-S3 uploads (as the plan suggests).** There's no bucket yet, and avatars are small
and need processing anyway. Post photos/videos (Phase 5) are where direct signed uploads pay off; only
`storage.js` has to change, and existing keys keep working.

### D35. Usernames: changeable every 14 days; `:user` accepts id or username
**Decision.** `PATCH /users/me/username` with `USERNAME_CHANGE_COOLDOWN_DAYS` (14) and an audit event. Routes
take `:user` as a UUID or a username (usernames can't contain "-", so they never look like a UUID). The
app should store ids and use usernames for deep links like `myvolapp://u/priya`.
**Not done.** Old usernames are released immediately (Instagram holds them ~14 days).

### D36. Posts: one multipart request, images only for now (2026-10-22)
**Decision.** `POST /posts` takes the form fields and up to 6 photos in one multipart request (JSON works
for text-only posts). Each photo is checked and re-encoded by sharp (longest side 1440 px, WebP, upright,
metadata stripped) and stored via `lib/storage.js`; `post_media` keeps the key, size and order. Width and
height are returned so the app can size the feed before images load. Field rules mirror the app's
ActivityForm (title ≤ 60, description ≤ 500 and required without photos, 9 categories, hours ≤ 24).
**Why not upload-then-attach.** It needs orphan cleanup for uploads never attached, and photos are small
enough for one request. Videos (Reels phase) should switch to direct signed uploads to S3.
**Not done.** Videos; changing a post's photos after creation (PATCH edits text fields only).

### D37. Post status with POST_AUTO_APPROVE until moderation exists
**Decision.** Posts have `status` UNDER_REVIEW / APPROVED / REJECTED (+ `rejection_reason`), matching
the app. Only APPROVED posts reach other people; the author always sees their own. Because reviewers
can't approve anything until the moderation phase, `POST_AUTO_APPROVE=true` (default) approves on
creation, which is what the app's mock already does. When moderation ships, set it to false: new posts
start UNDER_REVIEW and an edit sends a post back to review.

### D38. One visibility rule for posts, built on canView
**Decision.** `findVisiblePost` (single post) and `visibleTo` (Prisma where for lists) encode: author →
always; anyone else → APPROVED, author ACTIVE, and `socialGraph.canView` (public or approved follower).
Every read and every reaction (like, save, share, comment, comment like) goes through it, so a private
account's posts can't be liked or commented on by outsiders through a guessed id. Hidden posts are 404,
private ones 403 `PRIVATE_ACCOUNT`.

### D39. Feeds: chronological with keyset pagination
**Decision.** Home = your posts + approved posts of people you follow; Explore = approved posts from public
accounts, filterable by categories and city (case-insensitive match on `location`). Both are newest first,
paginated with the same opaque (created_at, id) cursor as follow lists.
**Why.** Correct and cheap at this size (indexes on author/status/category + created_at). Ranking
("popular", "near me"), fan-out tables and caching wait until usage shows they're needed.

### D40. Engagement counters: same pattern as follows; recount on bulk deletes
**Decision.** likes/saves/comments counters change in the transaction that writes the row, driven by
`createMany skipDuplicates` / `deleteMany` counts (double taps and concurrent requests are tested).
Deleting a comment recounts the post's comments (covers its cascaded replies). Purging a user recounts
every post and comment they touched. `@updatedAt` isn't used on posts because counter updates would
look like edits; `edited_at` is set only by PATCH. Shares count taps on the share button (not
de-duplicated, like Instagram).
**Comments.** One reply level, oldest first; the comment's author and the post's author may delete.
Creating posts/comments needs a verified email or phone (`requireVerified`); likes/saves don't.

### D41. Videos processed locally with bundled ffmpeg, behind one module (2026-10-22)
**Decision.** Video uploads go through `lib/videos.js`: ffprobe validates (real video stream, length ≤
`MAX_VIDEO_SECONDS`), then ffmpeg either re-packages (H.264/yuv420p/AAC, unrotated, ≤ 1080p: seconds) or
transcodes to 720p H.264 (`veryfast`, CRF 23), always dropping metadata (phones embed GPS) and adding
`+faststart` so playback starts before the download finishes. A WebP cover is cut at ~1 s. Binaries come
from npm (`ffmpeg-static` 6.1, `@ffprobe-installer/ffprobe` 2023 build; the older `ffprobe-static` 4.0 was
rejected because it parses untrusted files). Transcodes are serialised, uploads stream to temp files, not
memory. Files are served by express.static, which supports range requests.
**Why.** Works on any dev machine with `npm install`; the API and DB shape (`url`, `thumbnailUrl`,
`durationMs`) won't change when processing moves to the cloud.
**Trade-off / later.** Processing happens inside the upload request, so long videos make a slow request,
and one server can only transcode so much. For production: direct signed uploads to S3 + a video service
(Mux, Cloudinary, MediaConvert) with HLS, notifying the API when ready. Only `videos.js`, `storage.js` and
the create flow change.

### D42. Reels are single-video posts; views per unique viewer
**Decision.** No separate reels table: `posts.is_reel` = exactly one media item and it is a video (set on
create, indexed). `GET /posts/reels` uses the normal visibility rule. `post_views` has one row per
(viewer, post): the first play counts a view (`views_count`), later plays add `plays` and `watch_ms`; the
author's plays aren't counted.
**Why.** Matches Instagram (a single-video post is a reel and also shows in the feed) and keeps one code
path for likes, comments and visibility. Watch time is stored now so ranking (watch-through rate,
trending) can be added later without a migration. The feed is chronological until then.

### D43. Demo seed for local testing
**Decision.** `npm run db:seed:demo` creates the app's demo volunteers (`@demo.myvolapp.local`) with avatars,
follows, 5 reels (ffmpeg test patterns, or your own clips with `--videos`), photo posts, a carousel, likes,
comments and views, all through the real services. `--reset` removes them via the normal purge.

### Deliberately not done (yet)
| Item | Why it was deferred |
|---|---|
| Two-factor auth (TOTP + backup codes) | No UI in the app yet. Recommended before public launch, at least for staff/moderator roles. |
| Sign in with Apple | Required by App Store rules if Google sign-in ships on iOS. Android-first for now. |
| Real SMS delivery | Phone auth is built (D30) but codes go to the console. Needs a provider (MSG91 etc.) and a DLT-registered sender in India. |
| Block / mute, suggested volunteers | Phase 8. Plug block checks into `socialGraph` (findActiveUser/canView). |
| Cloud video (HLS, background processing) | Local ffmpeg for now (D41). |
| Reels ranking | Chronological; watch time is already recorded (D42). |
| Feed ranking / "Near me" / trending | Chronological is enough for now (D39). |
| Reporting posts/comments, approve/reject | Moderation phase. Set `POST_AUTO_APPROVE=false` then (D37). |
| Follow notifications | Phase 10 (notifications). The follow/accept code paths are the hook points. |
| S3/CDN storage | Swap `src/lib/storage.js` when a bucket exists (D34). |
| Removing a phone / freeing a slot | Not needed yet. Deleting the account frees the slot after the grace period. |
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
