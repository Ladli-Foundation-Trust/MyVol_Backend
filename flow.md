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

## 4e. Notifications (`/api/v1/notifications`, `/api/v1/settings`, live at `/api/v1/ws`)

```
an action (follow, like, comment, comment like, accept request)
  followService / postService.react / commentService
    prisma.$transaction(tx => {
        ...the action's own writes (row + counters)...
        notificationService.<event>(tx, ...)   createMany skipDuplicates on (recipient, dedupe_key)
                                               → new id, or null (self-action / duplicate)
        undo events (unlike, unfollow, decline) → delete by dedupe_key → recipients whose count changed
        deleting a post/comment                → recipientsOf() first (their rows go by cascade)
    })
    notificationService.deliver(ids)           after commit; background (inFlight set)
      sendOne(id)
        notification gone? recipient not ACTIVE? → stop
        recipient has no connected device?       → stop (the app catches up from the list on open)
        alert = settings: pauseAll / 'off' / false → null
                          'following' → recipient follows actor? else null
                          same (recipient, dedupe_key) alerted < 1 h ago → null
                          quiet hours → { sound: false, vibrate: false, channelId: 'silent' }
        realtime.sendToUser(recipient, { type: 'notification', notification, unreadCount, alert })
    notificationService.syncCount(userIds)     → { type: 'unread_count', unreadCount } to their devices

lib/realtime.js  (server.js attaches it to the HTTP server; same port)
  upgrade on /api/v1/ws (other paths → 404; browser Origin must be in CORS_ORIGINS)
  first message { type: 'auth', token } (or Authorization header) → middleware/auth.authenticate()
     ok → sockets[userId].add(ws) → { type: 'ready', userId, unreadCount }
     bad → close 4401 <code>; nothing within 10 s → close 4408; > MAX_SESSIONS_PER_USER → 4429
  every 30 s: ping (no pong since last time → terminate); sessions of all sockets in one query
              → revoked / expired / user not ACTIVE → close 4401 SESSION_INVALID

GET  /notifications            visible = recipient me AND (no actor OR actor ACTIVE)
                               keyset on created_at desc, id desc; message built per row
POST /:id/read, /read-all, DELETE /:id → also syncCount(me) so my other devices update
PATCH /settings                INSERT … ON CONFLICT DO UPDATE SET data = data || patch (atomic merge)
```

## 4f. Block, mute, search, reports, moderation

```
socialGraph (every read of other people goes through these)
  findActiveUser(:user, { viewerId })  + "they haven't blocked viewer" → else 404
  notBlockedWith(viewer)               Prisma where: no block either way (spread into lists)
  relationsFor(viewer, ids)            4 queries → followStatus, followsYou, blockedByMe, blocksMe
  canView(viewer, user, rel)           own || (no block && (public || following))
  isBlockedBetween(a, b, tx)           follow → 403 USER_BLOCKED; notificationService.record → skip

POST /users/:user/block   tx { blocks createMany skipDuplicates → removeFollow both ways
                                → delete follow_requests both ways → delete notifications between }
                          → syncCount(both)
POST /users/:user/mute    mutes createMany; feeds/explore/reels add author.mutesReceived none

GET /search/users     raw SQL: ACTIVE, NOT EXISTS block, ILIKE '%q%' | % (trigram) on username/name/city
                      ORDER BY exact, prefix, similarity, followers; LIMIT/OFFSET (cursor "o:<n>", ≤ 500)
                      → users + relationsFor
GET /search/posts     pageOfPosts(visibleTo(viewer) AND (title|description|location|category|
                      author name ILIKE | hashtag contains)) — keyset like the feeds
GET /search/hashtags  raw SQL on hashtags (posts_count > 0), offset cursor
create/edit post      tx { … → setPostHashtags(extractHashtags(title, description)) → recount }

POST /reports         reportLimiter → resolveTarget (must be visible to you, not yours)
                      tx { open report by me on it? → return it (200)
                           create → POST: distinct open reporters ≥ REPORT_AUTO_HIDE_THRESHOLD
                                    → APPROVED→UNDER_REVIEW + moderation_actions AUTO_HIDE_POST }

/admin/*              protect → restrictTo(REVIEWER, ADMIN) [→ restrictTo(ADMIN) for users/actions]
  approve|reject      tx { post.status → log → close open reports on it (DISMISSED|RESOLVED)
                           → postReviewed notification if the status changed } → deliver
  remove comment      tx { log (with text) → close its reports } → commentService.removeComment
  suspend             tx { SUSPENDED → revokeAllSessions → log → close USER reports }
                      → realtime.disconnectUser
  resolve report      remove → reject/removeComment; suspend → suspendUser (ADMIN);
                      then close every open report on the same target + log
```

## 4g. Impact & medals (`/users/me/impact`, `/users/:user/impact`, `profile.impact`)

```
impactService (posts WHERE author_id = u AND status = 'APPROVED'; config/medals.js = the tiers)
  totals          aggregate: count, sum(hours), sum(beneficiaries), sum(likes_count)
  byCategory      groupBy(category)                   only if canView (null otherwise)
  medalsFor(n)    current = highest tier ≤ n, next = first tier > n (+ remaining), tiers[].earned
  summaryFor      { activities, hours, beneficiaries, medal } → every profile (null across a block)

approval paths, inside their own transaction:
  postService.createPost   (POST_AUTO_APPROVE)            → impact.checkMedal(tx, author)
  moderationService.reviewPost   (status → APPROVED)       → impact.checkMedal(tx, author)
    checkMedal: count == a tier's threshold → notifications.medalEarned (dedupe medal:<tier>)
  → deliver() after commit (banner setting notifActivityApproved; url myvolapp://user/<me>)
```

## 4h. Settings and the rules they drive (`/api/v1/settings`)

```
GET   /settings → settingsService.getSettings(userId)
        one query: users.{is_private, activity_visibility, show_location} + user_settings.data
        → DEFAULTS (45 app keys) ← stored JSON keys ← the 3 column keys
PATCH /settings → validate(settingsValidators.updateSettings: built from DEFAULTS + OPTIONS)
      → accountSettingsService.updateSettings
        [tx] policy before {isPrivate, whoCanFollow}
             splitChanges → users columns update + writeJson (jsonb ||, atomic merge)
             followService.settlePendingRequests(before, after)
               approval needed before and not after → acceptAllRequests (follows + counters,
               FOLLOW_REQUEST notifications become FOLLOW)
PATCH /users/me {isPrivate} → profileService.updateMe → the same settlePendingRequests

Where each enforced key is read:
  whoCanFollow          followService.follow           none → 403 FOLLOWS_PAUSED; approve → request
  whoCanViewActivities  socialGraph.canViewActivities  + postService.visibleTo / findVisiblePost / userPosts
                        (users.activity_visibility in SQL: feeds, explore, search, hashtags, saved, reels)
  showLocationOnPosts   postService.toPosts (location null) + locationContains (city filters, search)
  hideLikeCounts        postService.toPosts            likesCount null, likesHidden
  allowSharing          postService.toPosts (canShare) + sharePost (403 SHARING_DISABLED)
  whoCanComment         postService.commentAllowed     toPosts (canComment) + commentService.addComment
  hideOffensiveComments commentService                 list filters + ?hidden=true + no notifications
  showImpactStats       profileService.getProfile (impact null) + impactService.getImpact (403)
  suggestToOthers, showSuggestedVolunteers             suggestionService
  feedSort              postService.homeFeed
  loginAlerts           authService.completeLogin
  notification keys     notificationService.alertFor   (banner only, 4e)
toPosts reads the authors' settings for a whole page with settingsService.settingsFor(ids): one query.
```

## 4i. Stories (`/api/v1/stories`, `/users/:user/stories`)

```
POST /stories → protect → requireVerified → storyLimiter → storyUpload (multer single 'media', OS temp)
            → requireMedia → validate(createStory) → storyService.createStory
              video → lib/videos.processVideo(path, { maxSeconds: STORY_MAX_VIDEO_SECONDS }) → mp4 + webp
              photo → lib/images.toPostImage → webp
              storage.save('stories/<id>.*') → stories row (expires_at = now + STORY_LIFETIME_HOURS)
              any failure → saved files removed; temp file removed when the response closes
GET  /stories/tray         stories (live, author ACTIVE, author = me OR followed by me and not muted)
                           + story_views of mine → group by author → me first, unseen first, newest
GET  /users/:user/stories  findActiveUser (404 if they blocked me) → canView (403) → live, oldest first
GET  /stories/:id          findVisibleStory: live (else 404) → author ACTIVE → no block (404) → canView (403)
POST /stories/:id/view     findVisibleStory → [tx] story_views createMany skipDuplicates
                           → count 1 → stories.views_count + 1 (never for the author)
GET  /stories/:id/viewers  author only → story_views (viewer ACTIVE, notBlockedWith) newest first
DELETE /stories/:id        author only → removeStory: delete row (views cascade, reports SET NULL) → files
Reports: reportService type STORY → findVisibleStory; moderationService.removeStory (resolve "remove" or
  DELETE /admin/stories/:id) logs DELETE_STORY, resolves its reports, removeStory.
Expiry: every read filters expires_at > now; jobs/authCleanup deletes expired rows + files.
profileService: profile.stories = storySummary (count, hasUnseen) when the profile is visible.
```

## 4j. Discovery: feed sort, explore views, trending, stats, featured, suggestions

```
GET /posts/feed?sort        homeFeed: sort ?? settings.feedSort
                              latest      OR [own, fromFollowing]
                              following   fromFollowing (approved, followed, not muted, not onlyMe)
                              recommended OR [own, fromFollowing, interestsOf]
                                          interestsOf = publicActivities AND (category IN causes of
                                          profile.preferredAreas (AREA_CATEGORIES) OR location ~ profile.city)
                            → pageOfPosts (keyset, newest first) → { sort, posts, nextCursor }
GET /posts/explore?view     publicActivities (APPROVED, author ACTIVE, public, activities 'everyone',
                            not blocked, not muted) AND category AND city AND
                              near → profile.city (400 CITY_REQUIRED) | featured → featured_at NOT NULL
                              | videos → media some VIDEO
GET /posts/trending?days    ≤ 1000 newest publicActivities of the period → score in JS → sort →
                            offset page (utils/cursor offsetPage) → load posts → toPosts
GET /posts/explore/stats    raw SQL totals over approved posts of active users + groupBy(category)
POST|DELETE /admin/posts/:id/feature   moderationService.setFeatured (APPROVED only, 409) → featured_at
                            + moderation_actions FEATURE_POST / UNFEATURE_POST; reject clears featured_at
GET /users/me/suggestions   suggestionService.listSuggestions: settings.showSuggestedVolunteers off →
                            { enabled: false } ; else one ranked SQL query (exclusions: me, followed,
                            requested, blocks both ways, muted, dismissed, suggestToOthers false,
                            whoCanFollow none) ORDER BY followsYou, mutual, sameCity (COALESCE false),
                            followers_count, created_at → cards + reason (newest mutual's first name)
POST /users/me/suggestions/:userId/dismiss → suggestion_dismissals createMany skipDuplicates
```

## 4k. Data export and login alerts

```
POST /users/me/export → protect → exportLimiter → validate(exportData) → userController.exportData
  → exportService.exportData: reauthService.assertReauthenticated (password, or a recent Google sign-in)
    → ~17 parallel reads (account, profile, settings, posts + media + hashtags, comments, likes, saves,
      followers, following, requests both ways, blocks, mutes, stories, notifications, reports made,
      active sessions, last 500 auth_events) → audit data_exported
  → Content-Disposition: attachment; Cache-Control: no-store → { status, data }
Login alert: authService.completeLogin [tx] counts sessions with this deviceName + user agent (seen)
  and all sessions (earlier) → newDevice = earlier > 0 && seen == 0
  → after commit: audit new_device_login; settings.loginAlerts → queueMail(emails.newLogin)
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
    delete notifications  older than NOTIFICATION_RETENTION_DAYS (90)
    delete stories        expired, or by purged users                       (story_views cascade)
    recount hashtags.posts_count; delete unused hashtags older than 1 d
    (before purging users: subtract their follows from other users' counters, note which
     posts/comments/stories they liked, saved, commented on or viewed; after the delete, recount
     those counters; after commit: delete their avatar, post and story files)
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
users ─┬─< notifications (recipient_id; actor_id, post_id, comment_id all cascade)
       │       UNIQUE (recipient_id, dedupe_key)
       ├─o user_settings (data JSONB)
       ├─< blocks (blocker_id, blocked_id) / mutes (muter_id, muted_id)   PK pairs, cascade
       ├─< reports (reporter_id; post_id/comment_id/user_id SET NULL, so reports outlive content)
       └─< moderation_actions (moderator_id SET NULL; target_type + target_id, no FK: audit log)
posts ─< post_hashtags >─ hashtags (name unique, posts_count)
users ─┬─< stories (expires_at, views_count) ─< story_views (story_id, viewer_id)
       └─< suggestion_dismissals (user_id, dismissed_id)
users.activity_visibility ('everyone'|'followers'|'onlyMe', CHECK) and users.show_location are settings
stored as columns; posts.featured_at = staff pick; comments.is_offensive = matched the word list;
reports.story_id (SET NULL) for type STORY.
users.role: USER | REVIEWER | ADMIN. GIN trigram indexes: users.username/name, posts.title/description,
hashtags.name (extension pg_trgm).
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
6. Notifications: open the WebSocket after login and whenever the app returns to the foreground, send
   `{ type: 'auth', token }`, close it on logout. On 4401 `TOKEN_EXPIRED` refresh and reconnect; other
   closes → reconnect with backoff. Show `alert`s as local notifications (`expo-notifications`, channels
   `default`, `sound-only`, `vibrate-only`, `silent`); on tap open `data.url` (README "Notifications").

## 8. Tests

`test/helpers.js` (supertest app, `resetDb` guard for `*_test` databases, `lastCodeFor` reads codes from
`mailer.outbox`, `lastSmsCodeFor` reads `sms.outbox`), `test/auth.test.js` (30 tests, one `describe`
per flow above), `test/phone.test.js` (16 phone tests) , `test/users.test.js` (17 profile/follow
tests) , `test/posts.test.js` (17 post/feed/comment tests), `test/videos.test.js` (7 video/reel tests,
clips generated with ffmpeg) and `test/notifications.test.js` (31 tests: the WebSocket login/close codes/
logout disconnect, every event type, undo, read/delete across devices, settings and banners, cleanup; it
starts a real server on a random port and connects with a `ws` client like the app),
`test/safety.test.js`, `test/search.test.js`, `test/impact.test.js`, and for 4h–4k
`test/privacy.test.js` (settings and every rule they drive, login alerts, export),
`test/stories.test.js` and `test/discovery.test.js` (feed sort, explore views, featured, trending,
stats, suggestions). 182 tests in all. Run `npm test`. TESTING.md maps every feature to its tests and
Postman requests.
