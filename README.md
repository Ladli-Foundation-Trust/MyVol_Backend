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
| `npm run db:seed:demo` | Demo volunteers with reels, photo posts, follows, likes, comments (see "Videos & reels") |
| `npm run db:seed:e2e` | Named test accounts (`e2e_*`, password `Volunteer@2026`) that each show one state or rule: staff, private / followers-only / only-me profiles, follow policies, blocks, mutes, posts in every status, stories, hidden comments, open reports, suspended / locked / deactivated accounts. `-- --reset` recreates them. See [TESTING.md](TESTING.md) |
| `npm test` | Migrate the test DB, then run the integration tests (`test/`) |
| `npm run auth:cleanup` | Purge expired tokens/codes and accounts past their deletion date |
| `npm run db:clean-postman` | List the test users Postman runs create (`pm_…`/`ph_…`/`em_…` @example.com); add `-- --yes` to delete them. Refuses in production |
| `npm run ws:listen -- <user> <password>` | Log in and print live WebSocket events (see "Notifications") |
| `npm run user:role -- <username or email> ADMIN` | Give an account a staff role (`ADMIN`, `REVIEWER` or `USER`). How the first admin is made |

### Testing the API in Postman (no email/SMS needed)

There is **one** collection for the whole API: `postman/MyVolApp-API.postman_collection.json`.
Keep it updated with every new endpoint (new features get new numbered folders).

1. In `.env`: `EXPOSE_OTP_IN_RESPONSE=true` (codes are then also returned as `data.devOtp`). The server
   refuses to start with it in production.
2. `npm run db:seed:e2e` (the staff account the collection logs in with, and the accounts folder S checks)
3. `npm run dev`
4. From this folder, run `postman collection run postman/MyVolApp-API.postman_collection.json`, or
   import it into the Postman app and use the Collection Runner (~3 min, 462 requests).

**Every JSON request carries its other possible bodies as commented-out alternatives** under the active
one, each labelled with what it tests and the expected result (the first request of an endpoint has the
full list, later ones point to it). Comment out the active body, uncomment one, Send: Postman strips the
comments. List and search requests have their optional query params as unticked rows; uploads have their
optional fields and bad files as unticked rows. [TESTING.md](TESTING.md) walks through every feature,
rule and request.

Folders 0–10 cover auth: verify email, refresh + reuse detection, sessions, change/forgot/reset password,
change email, logout, deactivate/delete, lockout, Google, then phone signup/login/multi-account/reset/
add-phone (waits 61 s once for the code cooldown). Folders 11–16 cover profiles and follow, 17–21 posts,
feeds, likes, saves, shares and comments, 22 videos and reels (uploads read `postman/fixtures/`),
23 notifications and settings (the runner can't open WebSockets: watch live events with `npm run ws:listen`),
24 block and mute, 25 search and hashtags, 26 reports and moderation, 27 impact and medals, 28 every setting
and the privacy rules it drives, 29 stories, 30 suggested volunteers, 31 feed sort / explore views /
trending / community stats / featured posts, 32 data export and login alerts, S the seeded accounts.
Staff requests log in with the collection variables `adminLogin` / `adminPassword` (default: the seeded
`e2e_admin` / `Volunteer@2026`; any admin made with `npm run user:role -- <username> ADMIN` works); if
`adminLogin` is empty those requests are skipped. They make B a reviewer and then a user again.
The collection is git-ignored (local only), like every `.env*` file.
Tokens and codes are saved into collection variables, so single requests also work by hand.
Google sign-in runs only when the `googleIdToken` variable is set (see that folder's description).
Each run adds 9 test users with random handles and `@example.com` emails (phone ones have no
email). That is intended, so every run gets unique accounts. Clear them with `npm run db:clean-postman -- --yes`.
A full run uses exactly 10 sign-ups (the local limit per hour per IP). If you hit `RATE_LIMITED`,
restart the server: limits are in memory.

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
src/services/socialGraph.js   user lookup, relationship (followStatus/followsYou), privacy rule
src/lib/storage.js      file storage (local disk now; swap for S3/Cloudinary here only)
src/lib/images.js       avatar + post photo processing (sharp)
src/lib/videos.js       video probe/transcode/cover (bundled ffmpeg), one at a time
src/services/postService.js     posts, feeds, likes/saves/shares, the post visibility rule
src/services/commentService.js  comments, replies, comment likes
src/services/notificationService.js  Activity list, recording events, live delivery + banner rules
src/services/settingsService.js app settings (all 45 app keys: JSONB + 3 users columns, defaults merged at read time)
src/services/accountSettingsService.js  PATCH /settings (and what a follow-policy change does to pending requests)
src/services/storyService.js    stories, the tray, seen + viewers
src/services/suggestionService.js  "Suggested for you"
src/services/exportService.js   "Download your information"
src/config/offensiveWords.js    the hideOffensiveComments word list
scripts/seed-e2e.js     named end-to-end test accounts (npm run db:seed:e2e)
src/lib/realtime.js     our WebSocket server (/api/v1/ws): login, devices per user, heartbeat
scripts/ws-listen.js    prints live events for a user (npm run ws:listen)
uploads/                avatars and post photos in development (git-ignored)
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
| POST | `/login` | – | `identifier` (email, username or phone), `password, deviceName?` |
| POST | `/google` | – | `idToken, deviceName?` + for new users `dateOfBirth, acceptTerms, username?` |
| POST | `/refresh` | – | `refreshToken` (or the cookie) |
| POST | `/logout` | – | `refreshToken` (or the cookie) |
| GET | `/username-available` | – | `?username=` |
| POST | `/forgot-password` | – | `email` |
| POST | `/reset-password` | – | `email, otp, newPassword` |
| POST | `/phone/send-code` | – | `phone, purpose: signup \| login \| change` |
| POST | `/phone/verify-code` | – | `phone, otp` → `{ phoneToken, phoneTokenExpiresAt, accounts[] }` |
| POST | `/phone/signup` | – | `phoneToken, name, username, password, dateOfBirth, acceptTerms: true, deviceName?` |
| POST | `/phone/login` | – | `phoneToken, userId, deviceName?` (SMS-code login, no password) |
| POST | `/phone/reset-password` | – | `phoneToken, userId, newPassword` |
| GET | `/me` | Bearer | – |
| POST | `/email/verify` | Bearer | `otp` |
| POST | `/email/verify/resend` | Bearer | – |
| POST | `/email/change` | Bearer | `newEmail, password` |
| POST | `/email/change/confirm` | Bearer | `otp` (sent to the new address) |
| POST | `/phone/change` | Bearer | `phoneToken, password` (adds or replaces the phone) |
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
| 400 | `PHONE_TOKEN_INVALID` | phone verification expired or already used: send a new code |
| 400 | `ACCOUNT_NOT_ON_PHONE` | the chosen account isn't on that number (app bug or stale list) |
| 400 | `NO_EMAIL` | phone-only account: offer "add email" (`/email/change`) |
| 409 | `PHONE_LIMIT_REACHED` | number already has 4 accounts: show `message` |
| 429 | `ACCOUNT_LOCKED`, `CODE_COOLDOWN`, `CODE_LIMIT`, `RATE_LIMITED` | show `message` |

### Policies

- Passwords: argon2id; 8–128 chars, a letter and a number, not a common password, not containing the username/email.
- Age gate: `MIN_SIGNUP_AGE` (13). Terms acceptance is timestamped.
- Lockout: every 5th consecutive failed login locks the account (15 min, doubling, max 24 h).
- 6-digit codes: HMAC-hashed, 5 tries each, 60 s resend cooldown, max 5 per hour.
  **Without `SMTP_URL`, mail (and codes) are printed to the server console outside production.**
- Max 10 live sessions per user; the least recently used one is logged out.
- Deactivate = hidden until next login. Delete = 30-day grace, then purged by the cleanup job.
- Use `requireVerified` (after `protect`) on routes that create content or message people. A verified
  email or a phone number counts.
- Phone: up to `MAX_ACCOUNTS_PER_PHONE` (4) accounts per number. SMS codes follow the same limits as email
  codes. **No SMS provider yet: codes are printed to the server console as `[sms]` outside production.**
- Rate limits are in memory (reset on restart). Use a Redis store before running more than one instance.
- Cleanup runs every 6 h in-process (advisory-locked, so safe with several instances) and via `npm run auth:cleanup`.
## Profiles & follow

Base `/api/v1/users`. **Every route needs `Authorization: Bearer`.** `:user` is a user id or a username.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/me` | – | Own profile incl. `pendingRequestsCount`, `showPersonalDetails`, `usernameChangeAvailableAt` |
| PATCH | `/me` | any of `name, bio, isPrivate, dateOfBirth, showPersonalDetails, gender, country, state, city, qualification, fieldOfStudy, skills[], preferredAreas[], availability[], volunteeringTypes[]` | Send only changed fields; `""`/`null` clears text. Private → public approves all pending requests |
| PATCH | `/me/username` | `username` | Once per 14 days (`USERNAME_CHANGE_COOLDOWN_DAYS`) |
| PUT | `/me/avatar` | multipart, file field `avatar` | JPEG/PNG/WebP/HEIC ≤ 5 MB → 512×512 WebP, metadata (GPS) stripped |
| DELETE | `/me/avatar` | – | |
| GET | `/me/follow-requests` | `?cursor&limit` | Pending requests to my private account |
| POST | `/me/follow-requests/:userId/accept` | – | |
| DELETE | `/me/follow-requests/:userId` | – | Decline |
| GET | `/:user` | – | Someone's profile (`details: null` if private and not following) |
| GET | `/:user/followers` | `?cursor&limit` (1–50, default 20) | 403 `PRIVATE_ACCOUNT` if hidden |
| GET | `/:user/following` | `?cursor&limit` | |
| POST | `/:user/follow` | – | → `{ followStatus: 'following' \| 'requested' }` (private = request) |
| DELETE | `/:user/follow` | – | Unfollow or cancel a request → `{ followStatus: 'none' }` |
| DELETE | `/:user/follower` | – | Remove that person from my followers |
| POST / DELETE | `/:user/block` | – | → `{ blocked }`. See "Block & mute" |
| POST / DELETE | `/:user/mute` | – | → `{ muted }` |
| GET | `/me/blocked`, `/me/muted` | `?cursor&limit` | Settings lists, newest first (rows add `blockedAt` / `mutedAt`) |
| GET | `/me/impact`, `/:user/impact` | – | See "Impact & medals" |
| GET | `/me/suggestions` | `?limit` (1–30, default 10) | See "Suggested volunteers" |
| POST | `/me/suggestions/:userId/dismiss` | – | The card's ✕; never suggested again |
| GET | `/:user/stories` | – | Their live stories, oldest first. See "Stories" |
| POST | `/me/export` | `{ password }` | "Download your information": a JSON file. See "Data export & login alerts" |

Profile shape: `{ id, username, name, bio, avatarUrl, isPrivate, followersCount, followingCount, createdAt,
isMe, followStatus, followsYou, canViewContent, canViewActivities, details, impact, stories, blockedByMe,
mutedByMe, followRequiresApproval, followsPaused }`. `impact` is `{ activities, hours, beneficiaries, medal }`
(`null` for someone you blocked, or when they turned `showImpactStats` off). `canViewActivities` = may the
viewer open the posts grid (`whoCanViewActivities`). `stories` = `{ count, hasUnseen }` for the avatar ring.
`followRequiresApproval` / `followsPaused` drive the follow button ("Request" / disabled) from the owner's
`privateAccount` and `whoCanFollow`. `details` has location, skills, preferred
areas, availability and volunteering types; gender, dateOfBirth, qualification and fieldOfStudy are added
only for the owner or when `showPersonalDetails` is on.

List rows: `{ id, username, name, avatarUrl, isPrivate, isMe, followStatus, followsYou }`.
Lists return `{ users, nextCursor }`; pass `nextCursor` back as `?cursor=` until it is `null`.

Privacy rule (`socialGraph.canView`): you see details, lists and posts if the account is yours, or there
is no block between you and it is public or you follow it. Deactivated/suspended/pending-deletion users,
and anyone who blocked you, are 404 and are left out of lists.

Testing in Postman: folders 11–16 of `postman/MyVolApp-API.postman_collection.json` (see above).

| HTTP | `code` | Meaning |
|---|---|---|
| 404 | `USER_NOT_FOUND` | no such active user |
| 403 | `PRIVATE_ACCOUNT` | private and you don't follow them: show the lock screen |
| 400 | `CANNOT_FOLLOW_SELF`, `CANNOT_TARGET_SELF`, `USERNAME_UNCHANGED`, `INVALID_CURSOR` | |
| 403 | `USER_BLOCKED` | you blocked them: unblock before following |
| 409 | `USERNAME_TAKEN` | |
| 429 | `USERNAME_CHANGE_TOO_SOON` | `details[0].message` has the date |
| 404 | `REQUEST_NOT_FOUND` | request already handled |
| 400 | `INVALID_IMAGE`, `FILE_REQUIRED`, `INVALID_UPLOAD` / 413 `FILE_TOO_LARGE` | avatar upload problems |

## Posts, feed, likes, saves, comments

Base `/api/v1`. **Every route needs `Authorization: Bearer`.** Creating posts and comments also needs a
verified email or phone (403 `EMAIL_NOT_VERIFIED`); liking, saving and sharing don't.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/posts` | multipart: `title, category, description?, location?, beneficiaries?, hours?` + up to 6 files in `media`; or the same fields as JSON for a text-only post | Photos → WebP, longest side 1440 px, metadata stripped. No photos ⇒ description required |
| GET | `/posts/feed` | `?sort&cursor&limit` | Newest first. `sort` (default: the `feedSort` setting): `latest` = yours + people you follow; `following` = people you follow only; `recommended` = latest + public posts in your profile's causes (`preferredAreas`) or city. Response adds `sort` |
| GET | `/posts/explore` | `?view&category=A,B&city=X&cursor&limit` | Approved posts from public accounts that share activities with everyone. `view`: `all` (default), `near` (your profile city; 400 `CITY_REQUIRED` without one; response adds `city`), `featured` (staff picks), `videos` |
| GET | `/posts/trending` | `?days` (1–30, default 7), `limit` (default 10), `cursor` | Most engaged public activities of the period (likes + 2×comments + 2×saves + 3×shares + views/10, decayed by age). Offset cursor |
| GET | `/posts/explore/stats` | – | The community strip: `{ stats: { activities, beneficiaries, hours, volunteers, cities, byCategory } }` |
| GET | `/posts/saved` | `?cursor&limit` | Newest save first |
| GET | `/posts/:postId` | – | |
| PATCH | `/posts/:postId` | any of `title, description, location, category, beneficiaries, hours` | Author only; sets `editedAt` |
| DELETE | `/posts/:postId` | – | Author only; deletes photos, likes, saves, comments |
| POST / DELETE | `/posts/:postId/like` | – | → `{ liked, likesCount }`, safe to repeat |
| GET | `/posts/:postId/likes` | `?cursor&limit` | Who liked it (user cards) |
| POST / DELETE | `/posts/:postId/save` | – | → `{ saved, savesCount }` |
| POST | `/posts/:postId/share` | – | → `{ sharesCount }` (counts share-sheet taps) |
| GET | `/posts/:postId/comments` | `?hidden&cursor&limit` | Top-level comments, oldest first, each with `repliesCount`. `?hidden=true`: the post author's "Hidden comments" (403 `NOT_AUTHOR` for others) |
| POST | `/posts/:postId/comments` | `text` (1–1000), `parentId?` | Reply to a reply attaches to the same top-level comment. The post author's `whoCanComment` applies (403 `COMMENTS_OFF` / `COMMENTS_RESTRICTED`) |
| GET | `/comments/:commentId/replies` | `?cursor&limit` | Oldest first |
| DELETE | `/comments/:commentId` | – | Comment author or post author; deletes its replies too |
| POST / DELETE | `/comments/:commentId/like` | – | → `{ liked, likesCount }` |
| GET | `/users/:user/posts` | `?cursor&limit` | Profile grid. The owner also sees posts under review |

Post shape: `{ id, author (user card), media: [{ id, type: 'image', url, width, height }], title,
description, location, category, beneficiaries, hours, status, likesCount, commentsCount, savesCount,
sharesCount, likedByMe, savedByMe, isMine, hashtags, featured, likesHidden, commentPolicy, canComment,
canShare, createdAt, editedAt }`. The author's settings shape it for everyone else: `location` is `null`
when `showLocationOnPosts` is off, `likesCount` is `null` (and `likesHidden: true`) when `hideLikeCounts` is
on, `canShare` is false when `allowSharing` is off, and `canComment` / `commentPolicy` follow
`whoCanComment`. `hashtags` are the `#tags`
found in the title and description (lower-case, without `#`). `status` is `APPROVED`,
`UNDER_REVIEW` or `REJECTED` (the app shows "Approved", "Under Review", "Rejected").
Categories: Health, Animal Welfare, Hunger & Poverty, Drug Prevention, Education, Gender Equality,
Youth & Sports, Child Rights, Environment.

Comment shape: `{ id, postId, parentId, text, author, likesCount, likedByMe, repliesCount, hidden, createdAt, canDelete }`.
`hidden: true` marks an offensive comment (`src/config/offensiveWords.js`) on a post whose author has
`hideOffensiveComments` on: only its writer sees it in the thread, the post author sees it under Hidden
comments, and nobody is notified about it.

Who sees a post (`postService.findVisiblePost` / `visibleTo`): its author always; others only when it is
APPROVED, the author is active, there is no block between them, the author's profile is visible to
them (public, or approved follower), and the author's `whoCanViewActivities` lets them in (`everyone`;
`followers` = approved followers only, 403 `ACTIVITIES_FOLLOWERS_ONLY`; `onlyMe` = nobody, 404 on a post,
403 `ACTIVITIES_HIDDEN` on the grid). `POST_AUTO_APPROVE=true` (the default) approves posts on creation;
set it to `false` once reviewers work the queue (see "Reports & moderation"). Editing a rejected post
always sends it back to review.

| HTTP | `code` | Meaning |
|---|---|---|
| 404 | `POST_NOT_FOUND`, `COMMENT_NOT_FOUND` | doesn't exist or you can't see it |
| 403 | `PRIVATE_ACCOUNT` | private author you don't follow |
| 403 | `ACTIVITIES_FOLLOWERS_ONLY`, `ACTIVITIES_HIDDEN` | the author's `whoCanViewActivities` |
| 403 | `COMMENTS_OFF`, `COMMENTS_RESTRICTED` | the author's `whoCanComment` |
| 403 | `SHARING_DISABLED` | the author turned `allowSharing` off |
| 400 | `CITY_REQUIRED` | explore `view=near` without a city on your profile |
| 403 | `NOT_AUTHOR`, `NOT_ALLOWED` | edit/delete someone else's post or comment |
| 400 | `DESCRIPTION_REQUIRED` | text-only post without a description |
| 400 | `INVALID_IMAGE`, `INVALID_UPLOAD` / 413 `FILE_TOO_LARGE` | photo problems (max 6, 10 MB each) |

## Videos & reels

Videos use the same `POST /posts` upload as photos: put them in the `media` field (MP4/MOV/WebM, up to
`MAX_VIDEO_SECONDS` = 180 s and `MAX_POST_VIDEO_MB` = 100 MB; photos and videos can be mixed, 6 items max).
Each video is probed with ffprobe, has its metadata (GPS) removed, is re-packaged (already H.264/AAC) or
transcoded to 720p H.264 MP4 with `+faststart`, and gets a WebP cover. ffmpeg/ffprobe come from npm
(`ffmpeg-static`, `@ffprobe-installer/ffprobe`): nothing to install. Processing happens during the upload,
one video at a time (`src/lib/videos.js`).

A post whose only item is a video is a **reel** (`isReel: true`).

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/posts/reels` | `?cursor&limit` | Reels you can see (public, followed, your own), newest first |
| POST | `/posts/:postId/view` | `{ watchMs }` | Call when a video plays. First play per viewer = +1 `viewsCount`; repeats add plays/watch time; the author's own plays don't count |

Video media items: `{ id, type: 'video', url, thumbnailUrl, width, height, durationMs }`. Posts also have
`isReel` and `viewsCount`. Videos are served with HTTP range support (206), so players can seek.

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_VIDEO` | not a readable video |
| 400 | `VIDEO_TOO_LONG` | longer than `MAX_VIDEO_SECONDS` |
| 400 | `NOT_A_VIDEO` | `/view` on a post without a video |

**Demo data:** `npm run db:seed:demo` creates the app's volunteers (priya_sharma, aarav_mehta, meera_iyer,
rohan_gupta, ananya_singh; password `Volunteer2026`) with avatars, follows, 5 reels, 3 photo posts, a
photo+video carousel, likes, comments and views. Options: `-- --reset` (recreate), `-- --follow <your
username>` (so they appear in your home feed), `-- --videos <folder>` (use your own clips for the reels
instead of generated test patterns).

## Notifications (live over our own WebSocket)

No Firebase, no Expo push service, no third party: notifications reach the app over a WebSocket on this
server (`src/lib/realtime.js`, built on the `ws` protocol library). The app shows them as phone
notifications itself (local notifications).

**What this means:** a notification arrives instantly while the app is open, or for a short while after
it goes to the background. When the app is closed (or Android has suspended it), nothing arrives; when it
opens again it reconnects, gets the unread count in `ready`, and reloads the list. Waking a closed app is
only possible through Google's FCM (Android) or Apple's APNs (iOS); that would be a later, optional step.

### REST

Base `/api/v1`. **Every route needs `Authorization: Bearer`.**

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/notifications` | `?cursor&limit` | The Activity tab, newest first → `{ notifications, nextCursor, unreadCount }` |
| GET | `/notifications/unread-count` | – | → `{ unreadCount }` for the bell/tab badge |
| POST | `/notifications/:id/read` | – | → `{ unreadCount }` |
| POST | `/notifications/read-all` | `{ before? }` (ISO time, optional) | Only up to `before` if given, so one arriving meanwhile stays unread |
| DELETE | `/notifications/:id` | – | → `{ unreadCount }` |
| POST | `/notifications/test` | – | Sends a `test` event to your connected devices → `{ devices }` |
| GET | `/settings` | – | → `{ settings }`: all 45 keys of the app's settings, defaults filled in (see "Settings") |
| PATCH | `/settings` | any subset of the keys | Merged into what is stored; unknown keys/values → 400 |

Notification shape: `{ id, type, message, actor (user card or null), post: { id, title, thumbnailUrl } | null,
comment: { id, text } | null, url, read, createdAt }`. `message` is ready to show ("Priya Sharma liked your
activity "Beach cleanup"."). `url` is the app deep link (`myvolapp://post/<id>` or `myvolapp://user/<id>`).

| `type` | When | Banner setting |
|---|---|---|
| `follow` | someone follows you (or you accepted their request) | `notifNewFollowers` |
| `follow_request` | someone asks to follow your private account (gone once accepted/declined/cancelled) | `notifFollowRequests` |
| `follow_accepted` | your request was accepted | `notifFollowRequests` |
| `like` / `comment_like` | your post / your comment was liked | `notifLikes` |
| `comment` | someone commented on your post | `notifComments` |
| `reply` | someone replied to your comment | `notifComments` |
| `approved` / `rejected` | a reviewer approved/rejected your post (only when its status really changes) | `notifActivityApproved` |
| `medal` | an approval took you to a medal tier (once per tier; opens your profile) | `notifActivityApproved` |

Undoing an action deletes its notification (unlike, unfollow, cancelled request, deleted comment or post).
Repeating an action never makes a second one. You're never notified about your own actions.

**Settings only decide whether the app shows a phone banner** (the `alert` field below). The Activity list
always shows everything (like Instagram). Keys (same as the app's `settingsSlice`): `pauseAll`,
`notifLikes` / `notifComments` / `notifMentions` (`'off' | 'following' | 'everyone'`), `notifNewFollowers`,
`notifFollowRequests`, `notifActivityApproved`, `notifActivityReminders`, `notifNearbyOpportunities`,
`notifAnnouncements`, `emailWeeklyDigest`, `emailOpportunities`, `emailProductUpdates`, `notifSound`,
`notifVibrate`, `quietHours` (22:00–07:00 in `DEFAULT_TIMEZONE`: banner on the `silent` channel). Mentions,
reminders, nearby, announcements and the email keys are stored for later features. The other settings
(privacy, interactions, feed, media...) are in "Settings" below.

### The WebSocket: `ws://localhost:3000/api/v1/ws`

Same port as the API, so `adb reverse tcp:3000 tcp:3000` (the app's `npm run android`) covers it over USB.
JSON text messages:

| Direction | Message | Meaning |
|---|---|---|
| app → server | `{ "type": "auth", "token": "<accessToken>" }` | First message, within 10 s (or send `Authorization: Bearer` on connect) |
| server → app | `{ "type": "ready", "userId", "unreadCount" }` | Logged in; set the badge |
| server → app | `{ "type": "notification", "notification": {…same shape as the list…}, "unreadCount", "alert" }` | New notification. Prepend it to the list, set the badge. If `alert` is not null, show a phone notification with `alert.channelId` (`default` / `sound-only` / `vibrate-only` / `silent`) |
| server → app | `{ "type": "unread_count", "unreadCount" }` | The badge changed (unlike, read on another device, deleted comment...) |
| server → app | `{ "type": "test", "message", "alert" }` | From `POST /notifications/test` |
| app → server | `{ "type": "ping" }` → `{ "type": "pong" }` | Optional; the server also pings every 30 s |
| server → app | `{ "type": "error", "code", "message" }` | Bad message; the connection stays open |

Close codes: **4401** with reason `TOKEN_EXPIRED` → refresh the token and reconnect; `SESSION_INVALID` /
`ACCOUNT_INACTIVE` / `TOKEN_INVALID` → log out. **4408** no auth in time, **4429** too many connections
(max = `MAX_SESSIONS_PER_USER`), **1001** server restarting → reconnect with backoff (1 s, 2 s, 4 s… max 30 s).
A logged-out or revoked session is disconnected within 30 s.

### What the app does

1. Connect after login, and again whenever the app comes to the foreground (`AppState` `active`); close it on
   logout. On `ready` set the badge; refetch `GET /notifications` when the Activity tab opens.
2. On `notification`: update the list and badge; if `alert` is set, show it with
   `Notifications.scheduleNotificationAsync({ content: { title: 'MyVolApp', body: message, data: { url } }, trigger: null })`
   (`expo-notifications`, local only: needs no Firebase, no EAS project, no push token). On Android create
   the four channels once at startup with `setNotificationChannelAsync`.
3. On a banner tap, open `data.url` (the app's linking config already handles `myvolapp://post/…` and `myvolapp://user/…`).

### Try it without the app

`npm run ws:listen -- priya_sharma Volunteer2026` logs in like the app and prints every event. Then, from
Postman or another terminal, like or comment on one of Priya's posts as another demo user: the event shows
up at once, with the badge count and whether a banner would show.

## Impact & medals

A volunteer's impact counts **approved** activities only (under review and rejected don't count), worked
out from their posts on every request.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/users/me/impact` | Yours, including `underReview` and `rejected` counts |
| GET | `/api/v1/users/:user/impact` | Someone else's. Totals and medals are public (like follower counts) unless they turned `showImpactStats` off (403 `IMPACT_HIDDEN`); `byCategory` is `null` if you can't see their activities (private and not following, or `whoCanViewActivities`). 404 if they blocked you, 403 `USER_BLOCKED` if you blocked them |

```json
{ "impact": {
    "activities": 4, "hours": 12, "beneficiaries": 180, "likesReceived": 37,
    "underReview": 1, "rejected": 0,
    "byCategory": [{ "category": "Health", "activities": 3, "hours": 9, "beneficiaries": 150 }],
    "medals": {
      "current": { "id": "bronze", "label": "Bronze Medal", "activities": 3 },
      "next": { "id": "silver", "label": "Silver Medal", "activities": 6, "remaining": 2 },
      "tiers": [{ "id": "bronze", "label": "Bronze Medal", "activities": 3, "earned": true }, "…silver 6, gold 12, platinum 25"]
    } } }
```

The app's screens map onto it like this: Home's "N activities away from…" banner = `medals.next`
(`null` once Platinum is earned); the Impact tab = `hours`, `beneficiaries` ("People impacted"),
`activities` ("Activities approved"), `likesReceived`, `underReview`; the profile header = `profile.impact`.
The tiers live in `src/config/medals.js`, so the app can stop hard-coding `MEDAL_TIERS`.
Medals follow the current count: deleting a post or having it rejected can take one away again. Reaching
a tier sends a `medal` notification once.

## Block & mute

Like Instagram, and neither person is told. Routes are under `/api/v1/users` (table above).

- **Block** works both ways once either side blocks. The person who blocked you is a 404 to you
  (profile, posts, comments, search, lists). Someone you blocked still opens as a profile with
  `blockedByMe: true` and no content, so the app can show "Unblock". Blocking removes follows and follow
  requests in both directions and the notifications between you, and stops new ones. Old likes and comments
  stay, hidden from each other. Unblocking doesn't restore follows.
- **Mute** removes their posts from your home feed, explore and reels. Their profile, links and search
  still show them, and follows are unchanged.

## Search & hashtags

Base `/api/v1`. **Every route needs `Authorization: Bearer`.** Limit: 90 searches a minute per user.

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/search/users` | `q` (1–100, a leading `@` is ignored), `cursor`, `limit` | "Volunteers" tab: username, name or city. Ranked exact → prefix → close match (typos) → followers. Rows add `city` |
| GET | `/search/posts` | `q` (a leading `#` is ignored), `cursor`, `limit` | "Activities" tab: title, description, location, category, author name or hashtag. Newest first; only posts you may see |
| GET | `/search/hashtags` | `q` (a leading `#` is ignored), `cursor`, `limit` | → `{ hashtags: [{ name, postsCount }] }`: exact, then prefix (most used first), then close matches |
| GET | `/hashtags/:tag/posts` | `cursor`, `limit` | A tag's page → `{ hashtag: { name, postsCount }, posts, nextCursor }`. 404 `HASHTAG_NOT_FOUND` |

Matching uses Postgres `pg_trgm` (the migration creates it; no superuser needed). People and hashtag
results page with an opaque cursor that stops after 500 results. Hashtags work in any script (`#स्वच्छता`).

## Reports & moderation

**Users** (base `/api/v1/reports`, 30 reports an hour per user). Reports are anonymous to the person
reported.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/reports` | `type` (`post` \| `comment` \| `user` \| `story`), `targetId` (an id, or a username for users), `reason`, `details?` (≤500) | 201, or 200 with `alreadyReported: true` if your report on it is still open. Only what you can see; never yourself |
| POST | `/reports/problem` | `category` (`bug` \| `content` \| `account` \| `idea`), `details` (15–1000), `deviceInfo?` | The app's "Report a problem" screen |

Reasons: `spam, nudity, hate_speech, harassment, violence, self_harm, false_information, scam,
intellectual_property, fake_account, other`. A post reported by `REPORT_AUTO_HIDE_THRESHOLD` (5)
different people is hidden (back to Under Review) until a reviewer decides; `0` turns that off.

**Staff** (base `/api/v1/admin`, role `REVIEWER` or `ADMIN`; others get 403 `FORBIDDEN`). Make the first
admin with `npm run user:role -- <username> ADMIN`; after that admins use the role endpoint.

| Method | Path | Body / query | Who | Notes |
|---|---|---|---|---|
| GET | `/admin/posts` | `?status=under_review\|rejected\|approved` (default under_review), `cursor`, `limit` | staff | Oldest first, any privacy; each post has `openReports: { count, reasons }` |
| POST | `/admin/posts/:postId/approve` | `note?` | staff | Dismisses its open reports; notifies the author if the status changed |
| POST | `/admin/posts/:postId/reject` | `reason` (3–300) | staff | Resolves its open reports; the author sees `rejectionReason` |
| POST / DELETE | `/admin/posts/:postId/feature` | – | staff | Staff pick for Explore's "Featured" view (approved posts only, else 409 `POST_NOT_APPROVED`); rejecting a post unfeatures it |
| DELETE | `/admin/comments/:commentId` | `reason` | staff | Deletes it and its replies; the text is kept in the audit log |
| DELETE | `/admin/stories/:storyId` | `reason` | staff | Deletes the story and its file, resolves its reports |
| GET | `/admin/reports` | `?status=open\|resolved\|dismissed` (default open), `type?` (`post\|comment\|user\|story\|problem`), `cursor`, `limit` | staff | Oldest first, with reporter, target (post / comment / story) and `openReportsOnTarget` |
| POST | `/admin/reports/:reportId/resolve` | `action` (`dismiss` \| `resolve` \| `remove` \| `suspend`), `note?` | staff (`suspend`: admin) | Closes every open report on the same target |
| POST | `/admin/users/:userId/suspend` | `reason` | admin | Logs them out everywhere and closes their WebSockets now |
| POST | `/admin/users/:userId/unsuspend` | `note?` | admin | |
| POST | `/admin/users/:userId/role` | `role` (`user` \| `reviewer` \| `admin`) | admin | Not your own |
| GET | `/admin/actions` | `?targetId&cursor&limit` | admin | Audit log, newest first (`moderator: null` = automatic or command line) |

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `CANNOT_REPORT_SELF`, `CANNOT_TARGET_SELF` | your own content/account |
| 400 | `NOTHING_TO_REMOVE`, `NOTHING_TO_SUSPEND` | that action doesn't fit this report |
| 403 | `FORBIDDEN` | not staff, or a reviewer doing an admin action |
| 403 | `TARGET_IS_ADMIN` | remove the admin role before suspending |
| 409 | `REPORT_CLOSED`, `NOT_SUSPENDED`, `ACCOUNT_DELETING` | |
| 404 | `REPORT_NOT_FOUND`, `POST_NOT_FOUND`, `COMMENT_NOT_FOUND`, `USER_NOT_FOUND` | |

## Settings

`GET /api/v1/settings` returns, and `PATCH /api/v1/settings` takes, the 45 keys of the app's
`SETTINGS_DEFAULTS` (MyVolApp `src/data/appSettingsContent.js`). Choice keys accept only their options,
every other key is a boolean; unknown keys → 400. Three keys are columns on `users` because list queries
filter on them (`privateAccount` = `is_private`, `whoCanViewActivities` = `activity_visibility`,
`showLocationOnPosts` = `show_location`); the rest are one JSONB object (`user_settings.data`).

| Key | Options (default first) | What the server does with it |
|---|---|---|
| `pauseAll`, `notifLikes`, `notifComments`, `notifNewFollowers`, `notifFollowRequests`, `notifActivityApproved`, `notifSound`, `notifVibrate`, `quietHours` | see "Notifications" | The phone-banner rules (`alert`) |
| `notifMentions`, `notifActivityReminders`, `notifNearbyOpportunities`, `notifAnnouncements`, `emailWeeklyDigest`, `emailOpportunities`, `emailProductUpdates` | – | Stored (no mentions, reminders, opportunities, announcements or digests yet) |
| `privateAccount` | `false` / true | = the profile's `isPrivate` (followers need approval, content for followers only). Going public approves waiting requests |
| `whoCanFollow` | `everyone` / `approve` / `none` | `approve`: a public account takes requests. `none`: 403 `FOLLOWS_PAUSED` for new followers, existing ones stay. Leaving `approve` approves waiting requests |
| `whoCanViewActivities` | `everyone` / `followers` / `onlyMe` | Who sees the posts (grid, feeds, explore, search, hashtags, saved, reels). See "Posts" |
| `showLocationOnPosts` | `true` / false | Off: `location` is null for others and city filters/search don't match it |
| `showImpactStats` | `true` / false | Off: `profile.impact` null and `/users/:user/impact` 403 `IMPACT_HIDDEN` for others |
| `suggestToOthers` | `true` / false | Off: never in anyone's "Suggested for you" |
| `showActivityStatus` | `true` / false | Stored (no presence yet; it belongs with chat) |
| `whoCanComment` | `everyone` / `followers` / `following` / `off` | Enforced on new comments and replies (403 `COMMENTS_OFF` / `COMMENTS_RESTRICTED`); posts carry `canComment` |
| `hideOffensiveComments` | `true` / false | Hides offensive comments from everyone but their writer; the author sees them under `?hidden=true` |
| `hideLikeCounts` | `false` / true | On: `likesCount` null for others |
| `allowSharing` | `true` / false | Off: `POST /posts/:id/share` 403 `SHARING_DISABLED` for others; posts carry `canShare` |
| `whoCanMention`, `whoCanTag`, `allowReposts` | `everyone`/`following`/`none`; `following`/`everyone`/`none`; `true` | Stored (no mentions, tags or reposts yet) |
| `feedSort` | `recommended` / `latest` / `following` | The home feed's default (`?sort=` overrides) |
| `showSuggestedVolunteers` | `true` / false | Off: `/users/me/suggestions` → `{ enabled: false, users: [] }` |
| `nearbyRadius`, `sensitiveContent` | `'25'`/`'10'`/`'50'`/`'any'`; `standard`/`less` | Stored ("near you" is by city until there is geo data; posts have no sensitive flag yet) |
| `autoplayVideos`, `startVideosMuted`, `dataSaver`, `uploadQuality`, `saveOriginalPhotos` | `wifi`/`always`/`never`; `true`; `false`; `high`/`standard`; `false` | App-side only (stored so they follow the account) |
| `language`, `distanceUnit` | `en`/`hi`/`bn`/`mr`/`ta`/`te`/`gu`/`kn`/`pa`; `km`/`mi` | App-side only |
| `reduceMotion`, `altTextReminders`, `captionsByDefault` | `false`; `true`; `false` | App-side only |
| `loginAlerts` | `true` / false | Email on a sign-in from a new device (see "Data export & login alerts") |

## Stories

A story is one photo or video with an optional caption, gone `STORY_LIFETIME_HOURS` (24) after it was
shared, like the app's `storiesSlice`. Not reviewed, liked or commented on; never in the feed or grid.
Who sees it: the profile rule (public, or approved follower; nothing across a block). Base `/api/v1`, all
routes need `Authorization: Bearer`.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/stories` | multipart: one file in `media`, `caption?` (≤ 200) | Verified accounts only. Photo → WebP; video ≤ `STORY_MAX_VIDEO_SECONDS` (60) → MP4 + WebP cover. 30 an hour |
| GET | `/stories/tray` | – | The Home rail: `{ tray: [{ user, storiesCount, hasUnseen, latestAt }] }`. You first, then people you follow (not muted) with unwatched stories, then the rest, most recent first |
| GET | `/users/:user/stories` | – | `{ user, stories }`, oldest first (play order) |
| GET | `/stories/:storyId` | – | One story (404 `STORY_NOT_FOUND` once expired) |
| POST | `/stories/:storyId/view` | – | Mark seen. First time per viewer = +1 view; the author's own views don't count |
| GET | `/stories/:storyId/viewers` | `?cursor&limit` | Author only (403 `NOT_AUTHOR`): `{ viewsCount, viewers, nextCursor }`, newest first |
| DELETE | `/stories/:storyId` | – | Author only; the file goes too |

Story shape: `{ id, author, type: 'image'|'video', url, thumbnailUrl, width, height, durationMs, caption,
createdAt, expiresAt, seen, isMine, viewsCount (author only) }`. Profiles carry `stories: { count, hasUnseen }`
for the avatar ring. Expired stories disappear from every read at once; the cleanup job (every 6 h) deletes
them with their files. Reports: `POST /reports` with `type: 'story'`; staff remove with
`DELETE /admin/stories/:storyId` or `resolve` → `remove`.

## Suggested volunteers

`GET /api/v1/users/me/suggestions?limit=10` (1–30): the Home "Suggested for you" rail →
`{ enabled, users: [{ …user card, followersCount, reason: { type, text, mutualCount } }] }`.

- Ranked: `follows_you` ("Follows you") → `mutual` ("Followed by Priya + 2 more": people you follow follow
  them) → `same_city` ("Also in Mumbai", the profile cities) → `popular` ("Suggested for you", most followed).
- Never suggested: you, people you follow or have requested, blocks either way, people you muted or
  dismissed, people with `suggestToOthers` off or `whoCanFollow: none`, inactive accounts.
- `POST /api/v1/users/me/suggestions/:userId/dismiss` (the card's ✕) hides someone for good.
- Your own `showSuggestedVolunteers` off → `{ enabled: false, users: [] }`.

## Data export & login alerts

- `POST /api/v1/users/me/export` with `{ password }` ("Download your information"): the whole account as a
  JSON file (`Content-Disposition: attachment`): account, profile, settings, posts with media URLs,
  comments, likes, saves, followers, following, requests, blocks, mutes, stories, notifications, reports
  made, active sessions and the last 500 login events. Never password/token/code hashes or who reported
  you. Wrong or missing password → 403 `INVALID_PASSWORD` (Google-only accounts: a sign-in within 10 min,
  else `REAUTH_REQUIRED`). 5 an hour. Audited as `data_exported`.
- **Login alerts**: a sign-in (password, phone or Google) from a device the account hasn't used before (a
  new `deviceName` + user agent pair, and not the account's first session) is audited as
  `new_device_login` and, with `loginAlerts` on (default), emailed ("New sign-in to your MyVolApp
  account", printed to the console locally). Phone-only accounts have no email to send it to.

## Prisma 7 notes

- `prisma migrate dev` does **not** regenerate the client. Run `npm run db:generate` after every
  migration, or the server fails on startup with "Unknown field".

- The connection URL lives in `prisma.config.js`, not `schema.prisma`.
- Prisma 7 does not load `.env` by itself; `dotenv/config` does it.
- The client is generated into `src/generated/prisma`; import it from `src/lib/prisma.js`.
- The npm `latest` tag for the `prisma` CLI points at an 8.0 RC. Keep `prisma` and
  `@prisma/client` pinned to the same stable 7.x version.
