# Auth code flow

How a request travels through the files and functions. For *why* things work this way, see
[decision.md](decision.md) (the `Dx` references point there).

## 1. The layers

```
HTTP request
  │
  ▼
server.js ─────────────── starts Express, connects Prisma, schedules jobs/authCleanup every 6 h
  │
  ▼
src/app.js ────────────── helmet → cors → morgan → apiLimiter → express.json → cookieParser
  │                       mounts /health and /api/v1, then 404 catch-all, then errorHandler
  ▼
src/routes/index.js ───── /api/v1/auth → authRoutes
  │
  ▼
src/routes/authRoutes.js  per route: [rate limiter] → [protect] → [validate(zod)] → controller
  │                       also sets Cache-Control: no-store on every /auth response
  ▼
src/controllers/authController.js
  │   reads req (body, cookie, req.user), builds ctx = { ip, userAgent, deviceName },
  │   calls ONE service function, shapes the JSON + sets/clears the refresh cookie
  ▼
src/services/
  ├── authService.js ............ signup, login, Google, refresh, logout, me, email verify/change, passwords
  ├── accountService.js ......... deactivate, scheduleDeletion
  ├── sessionService.js ......... create / rotate / list / revoke sessions and refresh tokens
  ├── verificationCodeService.js  issue / check / markUsed 6-digit codes
  ├── reauthService.js .......... assertReauthenticated (password or recent sign-in)
  └── auditService.js ........... record(type, …) → auth_events (fire-and-forget)
  │
  ▼
src/lib/   prisma.js (DB) · mailer.js (SMTP/console/test outbox) · google.js (ID-token check)
src/utils/ tokens.js (JWT, random tokens, HMAC) · password.js (argon2) · publicUser.js · username.js · appError.js
src/emails/authEmails.js   subject + text for every email
```

Errors: any layer `throw new AppError(message, status, details, code)`. Express 5 forwards thrown errors
and rejected promises to `src/middleware/errorHandler.js`, which also maps JWT errors
(`TOKEN_EXPIRED`/`TOKEN_INVALID`) and Prisma errors (P2002 → 409) and sends `{ status, message, code?, details? }`.

## 2. Middleware used by auth routes

| File | Function | Does |
|---|---|---|
| `middleware/rateLimit.js` | `loginLimiter`, `signupLimiter`, `refreshLimiter`, `passwordResetLimiter`, `usernameCheckLimiter` | per-IP limits (D22) |
| | `accountActionLimiter` | per-user limit, placed **after** `protect` so `req.user` exists |
| `middleware/validate.js` | `validate({ body, query, params })` | runs the zod schema from `validators/authValidators.js`; replaces `req.body` with the cleaned data (`req.validatedQuery` for query) or throws 400 with `details` |
| `middleware/auth.js` | `protect` | see §3 |
| | `requireVerified` | 403 `EMAIL_NOT_VERIFIED` unless `req.user.verified` (verified email or a phone; for future posting/messaging routes) |
| | `restrictTo(...roles)` | 403 unless `req.user.role` matches |

## 3. `protect`: how a signed-in request is checked

```
Authorization: Bearer <jwt>
  └─ protect (middleware/auth.js)
       ├─ utils/tokens.verifyAccessToken(jwt)      signature, exp, iss, aud, HS256 only
       │     └─ throws → errorHandler → 401 TOKEN_EXPIRED / TOKEN_INVALID
       ├─ prisma.session.findUnique({ id: payload.sid, select: user{role,status,emailVerifiedAt} })
       ├─ reject: no session | revokedAt set | session.userId ≠ payload.sub   → 401 SESSION_INVALID
       ├─ reject: user.status ≠ ACTIVE                                        → 401 ACCOUNT_INACTIVE
       └─ req.user = { id, role (from DB), emailVerified, sessionId, sessionCreatedAt }
```

## 4. Flows

Notation: `A → B` = A calls B. `[tx]` = inside one `prisma.$transaction`. `audit(X)` = `auditService.record`
after commit. `mail(X)` = `mailer.queueMail` with `emails.X()`.

### Sign up: `POST /auth/signup`
```
signupLimiter → validate(signup) → authController.signup
  → authService.signup(body, ctx)
      → assertAvailable({ email, username })           409 EMAIL_TAKEN / USERNAME_TAKEN
      → utils/password.hashPassword                     argon2id
      [tx] prisma.user.create(termsAcceptedAt, dateOfBirth)
           → sessionService.createSession(user, ctx, tx)
               → session.create → issueRefreshToken (sha256 stored) → enforceSessionCap
               → tokens.signAccessToken(user, session.id)   { accessToken, accessTokenExpiresAt }
      audit(SIGNUP)
      → sendVerificationCode → verificationCodeService.issue(EMAIL_VERIFICATION) → mail(verifyEmail)
  → sendSession(201): sets refreshToken cookie + JSON { user, accessToken, …, refreshToken, … }
```
The validator already enforced: email/username format, reserved names, password policy + blocklist +
"not your username/email", age ≥ MIN_SIGNUP_AGE, `acceptTerms === true`.

### Log in: `POST /auth/login`
```
loginLimiter (counts failures only) → validate(login) → authController.login
  → authService.login({ identifier, password }, ctx)
      → prisma.user.findUnique(email OR username)
      → lockedUntil in future?                          429 ACCOUNT_LOCKED
      → verifyPassword  (or verifyDummy if no user: same timing)
      ✗ wrong → recordFailedLogin → failedLoginCount++ ; every 5th → lockedUntil (15m·2ⁿ, ≤24h)
              audit(LOGIN_FAILED / ACCOUNT_LOCKED) → 401 INVALID_CREDENTIALS
      ✓ right → completeLogin(user, ctx, 'password')
                  → SUSPENDED?  audit(LOGIN_BLOCKED) → 403 ACCOUNT_SUSPENDED
                  [tx] user.update(status ACTIVE, clear lock/deactivation/deletion, lastLoginAt)
                       → sessionService.createSession
                  audit(LOGIN) (+ ACCOUNT_REACTIVATED if it was DEACTIVATED/PENDING_DELETION)
  → sendSession(200) { …, reactivated }
```

### Google: `POST /auth/google`
```
loginLimiter → validate(google) → authController.google
  → authService.loginWithGoogle(body, ctx)
      → lib/google.verifyIdToken(idToken)    503 GOOGLE_NOT_CONFIGURED | 401 GOOGLE_TOKEN_INVALID
      → !emailVerified                        400 GOOGLE_EMAIL_UNVERIFIED
      ① oAuthAccount found (provider+sub)     → completeLogin(...)            isNewUser:false
      ② user with same email exists
           [tx] if email never verified: revokeAllSessions + passwordHash=null   (D12)
                oAuthAccount.create, emailVerifiedAt ??= now
           audit(GOOGLE_LINKED) mail(googleLinked) → completeLogin(...)         isNewUser:false
      ③ new user
           missing dateOfBirth/acceptTerms?  400 PROFILE_REQUIRED details:[fields]  (app re-calls)
           assertAvailable(username) or pickUsername(email) → utils/username.usernameCandidates
           user.create (+ nested oAuthAccount, emailVerifiedAt, termsAcceptedAt)
           audit(SIGNUP) → completeLogin(...)                                    isNewUser:true
  → sendSession(201 if new, else 200)
```

### Refresh: `POST /auth/refresh`
```
refreshLimiter → validate(refresh) → authController.refresh
  readRefreshToken: body.refreshToken || cookie
  → authService.refresh → sessionService.rotate(raw, ctx)
      → refreshToken.findUnique(sha256(raw)) incl. session.user
      ✗ not found / session revoked                         401 SESSION_INVALID
      ✗ token.usedAt set (REPLAY) → revokeSession('refresh_token_reuse'), audit → 401
      ✗ expired / user not ACTIVE                           401 SESSION_INVALID
      [tx] refreshToken.updateMany(id, usedAt:null → now)  count 0 = lost a race → 401
           session.update(expiresAt +30d sliding, lastUsedAt, ip, ua)
           issueRefreshToken → new token ; signAccessToken
  → sendSession(200). On any error the controller clears the cookie, then rethrows.
```

### Logout
```
POST /auth/logout           → authService.logout(raw) → findSessionByRefreshToken → revokeSession('logout'), audit
POST /auth/logout-all       protect → authService.logoutAll → revokeAllSessions('logout_all'), audit
GET  /auth/sessions         protect → sessionService.listSessions(userId, req.user.sessionId)  (current flag)
DELETE /auth/sessions/:id   protect → validate(params uuid) → sessionService.revokeUserSession  404 if not yours
```
The access tokens of a revoked session fail at once in `protect` (§3).

### Email verification
```
POST /auth/email/verify         protect → accountActionLimiter → validate(verifyCode)
  → authService.verifyEmail → codes.check(EMAIL_VERIFICATION)   wrong → attempts++ → 400 INVALID_CODE
       [tx] codes.markUsed (conditional) + user.emailVerifiedAt = now ; audit(EMAIL_VERIFIED)
POST /auth/email/verify/resend  protect → accountActionLimiter
  → authService.resendEmailVerification → already verified? 400 → sendVerificationCode
       → codes.issue   (60 s cooldown → 429 CODE_COOLDOWN, 5/hour → 429 CODE_LIMIT)
```

### Forgot / reset password
```
POST /auth/forgot-password  passwordResetLimiter → authService.requestPasswordReset
   unknown email → return silently ; codes.issue(PASSWORD_RESET) (429 swallowed) → mail(passwordReset)
   → always the same 200 message
POST /auth/reset-password   passwordResetLimiter → authService.resetPassword
   → codes.check(PASSWORD_RESET) → hashPassword
   [tx] codes.markUsed ; user.update(passwordHash, clear lockout, emailVerifiedAt ??= now)
        revokeAllSessions('password_reset')
   audit(PASSWORD_RESET) mail(passwordChanged) ; controller clears cookie
```

### Change password
```
PATCH /auth/change-password  protect → accountActionLimiter → validate(changePassword)
  → authService.changePassword(req.user, body)
      → reauthService.assertReauthenticated(user, currentPassword, req.user)
           has password: verify it        else: session younger than REAUTH_WINDOW
           ✗ → 403 INVALID_PASSWORD / REAUTH_REQUIRED
      [tx] user.update(passwordHash) ; revokeAllSessions(except req.user.sessionId)
      audit(PASSWORD_CHANGED) mail(passwordChanged) → { user }
```

### Change email (two steps)
```
POST /auth/email/change          protect → limiter → validate(emailChange)
  → authService.requestEmailChange → assertReauthenticated → same email? 400 → assertAvailable
     → codes.issue(EMAIL_CHANGE, target:newEmail) → mail(emailChange) to NEW address
POST /auth/email/change/confirm  protect → limiter → validate(verifyCode)
  → authService.confirmEmailChange → codes.check(EMAIL_CHANGE) → assertAvailable(record.target)
     [tx] markUsed ; user.update(email=target, emailVerifiedAt) ; revokeAllSessions(except current)
     audit(EMAIL_CHANGED) mail(emailChanged) to OLD address → { user }
```

### Deactivate / delete account
```
POST /auth/account/deactivate  protect → limiter → validate(confirmPassword)
  → accountService.deactivate → assertReauthenticated
     [tx] status DEACTIVATED + deactivatedAt ; revokeAllSessions ; audit
POST /auth/account/delete      same chain → accountService.scheduleDeletion
     [tx] status PENDING_DELETION + deletionScheduledAt (now + 30 d) ; revokeAllSessions
     audit ; mail(deletionScheduled) → { deletionScheduledAt }
Next login → completeLogin sets ACTIVE again (cancels both).
After the date → jobs/authCleanup purges the user (cascade).
```

### Phone (Instagram-style): `/auth/phone/*`

```
send-code {phone, purpose}     phoneAuthService.sendCode
  signup|change: assertPhoneHasRoom (409 PHONE_LIMIT_REACHED at 4 accounts) → issue → SMS
  login:         no accounts on the number → 200 and no SMS (same answer either way)
verify-code {phone, otp}       phoneCodeService.verify → { phoneToken (JWT, aud myvolapp-phone,
                               15 min, jti = phone_codes row), accounts: [{id, username, name}] }
then exactly one of (each consumes the phoneToken; consumed_at makes it single use):
  phone/signup          tx: lockPhone (advisory lock) → assertPhoneHasRoom → consume → create user → session
  phone/login           account must have that phone → consume → completeLogin('phone_code')
  phone/reset-password  account must have that phone → tx: consume, new hash, clear lockout, revoke all sessions
  phone/change (Bearer) re-auth → tx: lock → room → consume → set phone, revoke other sessions → tell old number/email
```
`POST /login` with a phone as `identifier` checks the password against each account on that number
(at most 4) and signs in to the one it matches.

### Username check: `GET /auth/username-available?username=`
```
usernameCheckLimiter → validate({ query }) (format + reserved → 400) → authService.checkUsername → { available }
```

## 4b. Profiles & follow (`/api/v1/users`, all behind `protect`)

```
userRoutes → userController → profileService / followService → socialGraph
                                                     │
  findActiveUser(:user)   id or username, status ACTIVE only (else 404 USER_NOT_FOUND)
  relationsFor(viewer, ids)  3 queries → followStatus (following|requested|none) + followsYou
  canView(viewer, user)   own || public || following      ← reuse for posts later
```
- **Follow**: tx { already following? → 'following' | private → follow_requests row → 'requested'
  | addFollow }. `addFollow`/`removeFollow` are the only writers of `follows`; they use
  createMany(skipDuplicates)/deleteMany and touch the counters only when a row really changed.
- **Accept request**: tx { delete request (404 if none) → addFollow }. **Go public**: tx { update
  user → acceptAllRequests }.
- **Lists**: keyset pagination on (created_at desc, other user id desc); cursor = base64url
  "iso|id" (`utils/cursor.js`), so pages don't shift when people follow meanwhile.
- **Avatar**: multer (memory, 5 MB, field `avatar`) → sharp (format whitelist, rotate, 512² WebP,
  metadata stripped) → storage.save(`avatars/<uuid>.webp`) → users.avatar_key → delete old file.
  Files are served by express.static at `/uploads` (cross-origin, cached 1 year).
- **Username change**: cooldown on `username_changed_at`; P2002 → 409 USERNAME_TAKEN.

## 4c. Posts (`/api/v1/posts`, `/api/v1/comments`, all behind `protect`)

```
postRoutes/commentRoutes → postController → postService / commentService → socialGraph
  findVisiblePost(viewer, id)  author → always; else APPROVED + author ACTIVE + canView(author)
                               (404 POST_NOT_FOUND / 403 PRIVATE_ACCOUNT)
  visibleTo(viewer)            the same rule as a Prisma where (saved list)
  toPosts(viewer, posts)       + likedByMe, savedByMe, author followStatus: 3 queries per page
```
- **Create**: requireVerified → postLimiter → multer (≤ 6 × 10 MB, field `media`) → zod (coerces
  multipart strings) → sharp each photo (1440 px WebP) → storage.save → `post.create` with media rows;
  if the insert fails the files are deleted. Status = APPROVED if POST_AUTO_APPROVE else UNDER_REVIEW.
- **Feeds** (keyset on created_at desc, id desc): home = own OR (APPROVED AND author followed by me);
  explore = APPROVED AND author public; both skip inactive authors.
- **Like/save**: tx { createMany skipDuplicates / deleteMany → counter ±1 only if a row changed }.
- **Comments**: tx { create (parent = top-level comment) → post.comments_count +1 → parent.replies_count +1 }.
  Delete: tx { delete (replies cascade) → recount post.comments_count → parent.replies_count −1 }.

## 4d. Videos & reels

```
POST /posts (multer → OS temp files, deleted when the response closes)
  per file: video/* → videos.processVideo(path)       (queued: one ffmpeg at a time)
                        ffprobe → duration ≤ MAX_VIDEO_SECONDS, has a video stream
                        h264 + yuv420p + aac + no rotation + ≤1080p → ffmpeg -c copy
                        else → libx264 veryfast crf 23, 720p short side, aac
                        always: -map_metadata -1 (no GPS), +faststart; cover frame → WebP
            image/*  → images.toPostImage
  storage.save(posts/<uuid>.mp4 + .webp) → post.create(isReel = 1 item && VIDEO)
GET /posts/reels   pageOfPosts({ isReel, ...visibleTo(viewer) })
POST /:id/view     visible + has a video; author → no-op; tx { createMany post_views
                   skipDuplicates → views_count+1 | else plays+1, watch_ms+= }
```

## 5. Background job

```
server.js start() → cleanup() now, then setInterval(6 h).unref()
scripts/auth-cleanup.js (npm run auth:cleanup) → same function, for cron

jobs/authCleanup.runAuthCleanup
  [tx, timeout 120 s]
    pg_try_advisory_xact_lock(hashtext('auth-cleanup'))   false → another instance is running → skip
    delete users          PENDING_DELETION and deletionScheduledAt ≤ now   (cascades)
    delete sessions       expired, or revoked > 30 d ago                   (cascades refresh tokens)
    delete refresh tokens expired, or used > 7 d ago
    delete codes          created > 1 d ago
    delete auth_events    older than 180 d
    (before purging users: subtract their follows from other users' counters, note which
     posts/comments they liked, saved or commented on; after the delete, recount those
     counters; after commit: delete their avatar and post photo files)
```

## 6. Data model (prisma/schema.prisma)

```
users ─┬─< sessions ─< refresh_tokens        a session = one device; tokens rotate inside it
       ├─< verification_codes                purpose: EMAIL_VERIFICATION | PASSWORD_RESET | EMAIL_CHANGE
       ├─< oauth_accounts                    (provider, provider_user_id) unique
       └─< auth_events                       append-only audit log
users ─┬─o profiles                          1:1, created on first profile edit
       ├─< follows (follower_id, following_id)      PK pair; CHECK not self
       └─< follow_requests (requester_id, target_id) pending follows of private accounts
users ─┬─< posts ─┬─< post_media (position)       photos; key = storage key
       │          ├─< post_likes (user_id, post_id)
       │          ├─< post_saves (user_id, post_id)
       │          ├─< post_views (user_id, post_id)  plays, watch_ms; first play = a view
       │          └─< comments ─< comment_likes     comments.parent_id → top-level comment
users.followers_count / following_count, posts.likes/comments/saves/shares_count and
comments.likes/replies_count are denormalised (CHECK >= 0).
All child FKs: ON DELETE CASCADE → purging a user removes everything above.
users.email is nullable, users.phone (E.164, indexed, NOT unique); CHECK email OR phone is set.
phone_codes (no FK: keyed by number, the account may not exist yet), purged after 1 day.
```

## 7. What the app has to do

1. Store `accessToken` in memory and `refreshToken` in SecureStore. Send `deviceName` (e.g. from
   `expo-device`) on signup/login/google.
2. On 401 `TOKEN_EXPIRED`: run **one** `/refresh` at a time, queue other requests, retry them with the
   new token. On any other 401: clear tokens → login screen.
3. After signup, show the verify-email screen if `user.emailVerified === false`.
4. For Google: get an ID token with `@react-native-google-signin/google-signin`, POST it. On
   `PROFILE_REQUIRED`, ask for DOB + terms (and optionally a username), then POST again with the same token.
5. Treat 403 `INVALID_PASSWORD` / `REAUTH_REQUIRED` as form errors, not logouts.

## 8. Tests

`test/helpers.js` (supertest app, `resetDb` guard for `*_test` databases, `lastCodeFor` reads codes from
`mailer.outbox`, `lastSmsCodeFor` reads `sms.outbox`), `test/auth.test.js` (30 tests, one `describe`
per flow above), `test/phone.test.js` (16 phone tests) , `test/users.test.js` (17 profile/follow
tests) , `test/posts.test.js` (17 post/feed/comment tests) and `test/videos.test.js` (7 video/reel tests,
clips generated with ffmpeg). Run `npm test`.
