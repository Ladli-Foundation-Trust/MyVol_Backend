# MyVolApp backend

Express 5 + PostgreSQL 18 + Prisma 7 (driver adapter `@prisma/adapter-pg`) + zod.
Serves the Expo app in `../MyVolApp` at `http://localhost:3000/api/v1`.

## Local setup

1. Install PostgreSQL 18 (official EDB installer, e.g. `winget install PostgreSQL.PostgreSQL.18`).
   It runs as the Windows service `postgresql-x64-18` on port 5432, localhost only.
2. Create the app role and database (as the `postgres` superuser):
   ```sql
   CREATE ROLE myvolapp WITH LOGIN CREATEDB PASSWORD '<strong password>';
   CREATE DATABASE myvolapp OWNER myvolapp;
   ```
   `CREATEDB` is needed because `prisma migrate dev` creates a temporary "shadow" database.
3. `cp .env.example .env` and put the password into `DATABASE_URL`.
4. `npm install` (also runs `prisma generate`)
5. `npm run db:migrate` — applies migrations
6. `npm run db:seed`
7. `npm run dev`

Check: `GET http://localhost:3000/health/ready` → `{ "status": "ready" }`.
Phone: `npm run adb:reverse` from the app folder so `localhost:3000` reaches this machine.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | API with nodemon |
| `npm run db:migrate` | Create + apply a migration after editing `schema.prisma` (`-- --name <name>`) |
| `npm run db:reset` | Drop, re-migrate, re-seed (destroys local data) |
| `npm run db:studio` | Prisma Studio GUI on http://localhost:5555 |
| `npm run db:seed` | Run `prisma/seed.js` |
| `npm test` | Migrate the test DB, then run the integration tests (`test/`) |
| `npm run auth:cleanup` | Purge expired tokens/codes and accounts past their deletion date |

### Tests

One-time setup: `CREATE DATABASE myvolapp_test OWNER myvolapp;` then `cp .env.test.example .env.test`
and fill in the password. Tests truncate tables and refuse to run unless the DB name ends in `_test`.
Sent mail goes to an in-memory outbox (`src/lib/mailer.js`) where tests read the codes.

## Layout

```
server.js               start + graceful shutdown
prisma.config.js        Prisma 7 config (schema path, DATABASE_URL, seed)
prisma/schema.prisma    data model
src/app.js              middleware + route mounting
src/config/env.js       zod-validated env
src/lib/prisma.js       shared PrismaClient
src/middleware/         errorHandler, validate (zod)
src/routes/             routers → controllers → services
src/generated/prisma    generated client (git-ignored)
```

Errors are `{ status, message, details? }`. The app's `src/api/client.js` reads `message`.

## Auth

Base `/api/v1/auth`. How it works: [flow.md](flow.md). Why it works that way: [decision.md](decision.md).

- **Access token**: 15-minute JWT (`sub`, `sid` = session id, `role`), sent as `Authorization: Bearer`.
- **Refresh token**: opaque, 30 days sliding, single use (rotates on every refresh). Returned in the
  body (mobile → SecureStore) and as an httpOnly cookie scoped to `/api/v1/auth` (web).
- Every session (= device) is a row in `sessions`; revoking it kills its tokens at once.

| Method | Path | Auth | Body / query |
|---|---|---|---|
| POST | `/signup` | – | `name, email, username, password, dateOfBirth (YYYY-MM-DD), acceptTerms: true, deviceName?` |
| POST | `/login` | – | `identifier` (email or username), `password, deviceName?` |
| POST | `/google` | – | `idToken, deviceName?` + for new users `dateOfBirth, acceptTerms, username?` |
| POST | `/refresh` | – | `refreshToken` (or the cookie) |
| POST | `/logout` | – | `refreshToken` (or the cookie) |
| GET | `/username-available` | – | `?username=` |
| POST | `/forgot-password` | – | `email` |
| POST | `/reset-password` | – | `email, otp, newPassword` |
| GET | `/me` | Bearer | – |
| POST | `/email/verify` | Bearer | `otp` |
| POST | `/email/verify/resend` | Bearer | – |
| POST | `/email/change` | Bearer | `newEmail, password` |
| POST | `/email/change/confirm` | Bearer | `otp` (sent to the new address) |
| PATCH | `/change-password` | Bearer | `currentPassword, newPassword` (Google-only users: just `newPassword`) |
| GET | `/sessions` | Bearer | – |
| DELETE | `/sessions/:sessionId` | Bearer | – |
| POST | `/logout-all` | Bearer | – |
| POST | `/account/deactivate` | Bearer | `password` |
| POST | `/account/delete` | Bearer | `password` |

Session responses: `{ user, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, reactivated?, isNewUser? }`.

### Error codes the app should handle

Errors are `{ status, message, code?, details? }`. Branch on `code`, show `message`.

| HTTP | `code` | App should |
|---|---|---|
| 401 | `TOKEN_EXPIRED` | call `/refresh` **once** (single-flight across all pending requests) and retry |
| 401 | `SESSION_INVALID`, `ACCOUNT_INACTIVE`, `TOKEN_INVALID`, `NOT_AUTHENTICATED` | clear tokens, go to login |
| 400 | `PROFILE_REQUIRED` | (Google) ask for `details[].field`, call `/google` again with the same idToken |
| 403 | `INVALID_PASSWORD` / `REAUTH_REQUIRED` | show error / ask the user to sign in again. **Not** a logout |
| 403 | `EMAIL_NOT_VERIFIED` | open the verify-email screen |
| 403 | `ACCOUNT_SUSPENDED` | show a suspension notice |
| 429 | `ACCOUNT_LOCKED`, `CODE_COOLDOWN`, `CODE_LIMIT`, `RATE_LIMITED` | show `message` |

### Policies

- Passwords: argon2id; 8–128 chars, a letter and a number, not a common password, not containing the username/email.
- Age gate: `MIN_SIGNUP_AGE` (13). Terms acceptance is timestamped.
- Lockout: every 5th consecutive failed login locks the account (15 min, doubling, max 24 h).
- 6-digit codes: HMAC-hashed, 5 tries each, 60 s resend cooldown, max 5 per hour.
  **Without `SMTP_URL`, mail (and codes) are printed to the server console outside production.**
- Max 10 live sessions per user; the least recently used one is logged out.
- Deactivate = hidden until next login. Delete = 30-day grace, then purged by the cleanup job.
- Use `requireVerifiedEmail` (after `protect`) on routes that create content or message people.
- Rate limits are in memory (reset on restart). Use a Redis store before running more than one instance.
- Cleanup runs every 6 h in-process (advisory-locked, so safe with several instances) and via `npm run auth:cleanup`.
## Prisma 7 notes

- `prisma migrate dev` does **not** regenerate the client. Run `npm run db:generate` after every
  migration, or the server fails on startup with "Unknown field".

- The connection URL lives in `prisma.config.js`, not `schema.prisma`.
- Prisma 7 does not load `.env` by itself; `dotenv/config` does it.
- The client is generated into `src/generated/prisma`; import it from `src/lib/prisma.js`.
- The npm `latest` tag for the `prisma` CLI points at an 8.0 RC. Keep `prisma` and
  `@prisma/client` pinned to the same stable 7.x version.
