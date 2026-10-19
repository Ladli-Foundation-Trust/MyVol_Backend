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
| | `requireVerifiedEmail` | 403 `EMAIL_NOT_VERIFIED` unless `req.user.emailVerified` (for future posting/messaging routes) |
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

### Username check: `GET /auth/username-available?username=`
```
usernameCheckLimiter → validate({ query }) (format + reserved → 400) → authService.checkUsername → { available }
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
```

## 6. Data model (prisma/schema.prisma)

```
users ─┬─< sessions ─< refresh_tokens        a session = one device; tokens rotate inside it
       ├─< verification_codes                purpose: EMAIL_VERIFICATION | PASSWORD_RESET | EMAIL_CHANGE
       ├─< oauth_accounts                    (provider, provider_user_id) unique
       └─< auth_events                       append-only audit log
All child FKs: ON DELETE CASCADE → purging a user removes everything above.
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
`mailer.outbox`) and `test/auth.test.js` (30 tests, one `describe` per flow above). Run `npm test`.
