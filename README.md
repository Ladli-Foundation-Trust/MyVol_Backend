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

Base: `/api/v1/auth`. Access token = 15-minute JWT, sent as `Authorization: Bearer <token>`.
Refresh token = opaque 30-day token, returned in the body **and** as an HTTP-only cookie
(scoped to `/api/v1/auth`). Only SHA-256 hashes of refresh tokens are stored.

| Method | Path | Auth | Body |
|---|---|---|---|
| POST | `/signup` | – | `name, email, username, password` |
| POST | `/login` | – | `email, password` |
| POST | `/refresh` | – | `refreshToken` (optional if the cookie is sent) |
| POST | `/logout` | – | `refreshToken` (optional if the cookie is sent) |
| POST | `/forgot-password` | – | `email` |
| POST | `/reset-password` | – | `email, otp, newPassword` |
| GET | `/me` | Bearer | – |
| POST | `/logout-all` | Bearer | – |
| PATCH | `/change-password` | Bearer | `currentPassword, newPassword` |

- Passwords: argon2id; 8–128 chars with at least one letter and one number.
- Refresh tokens rotate on every use. Replaying a used one revokes that whole login (reuse detection).
- `users.token_version` is embedded in access tokens; password change/reset and logout-all bump it,
  which kills every outstanding access token immediately.
- Reset codes are 6 digits, valid 10 minutes, max 5 wrong tries. **No email provider yet:
  outside production the code is printed to the server console.**
- Rate limits (per IP, in memory): login 10 / 15 min, signup 10 / hour, forgot + reset 5 / 15 min.
  Restarting the server resets them. Use a Redis store before running more than one instance.

## Prisma 7 notes

- `prisma migrate dev` does **not** regenerate the client. Run `npm run db:generate` after every
  migration, or the server fails on startup with "Unknown field".

- The connection URL lives in `prisma.config.js`, not `schema.prisma`.
- Prisma 7 does not load `.env` by itself; `dotenv/config` does it.
- The client is generated into `src/generated/prisma`; import it from `src/lib/prisma.js`.
- The npm `latest` tag for the `prisma` CLI points at an 8.0 RC. Keep `prisma` and
  `@prisma/client` pinned to the same stable 7.x version.
