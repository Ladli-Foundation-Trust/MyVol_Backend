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
2. `npm run dev`
3. From this folder, run `postman collection run postman/MyVolApp-API.postman_collection.json`, or
   import it into the Postman app and use the Collection Runner (~95 s, 280 requests).

Folders 0–10 cover auth: verify email, refresh + reuse detection, sessions, change/forgot/reset password,
change email, logout, deactivate/delete, lockout, Google, then phone signup/login/multi-account/reset/
add-phone (waits 61 s once for the code cooldown). Folders 11–16 cover profiles and follow, 17–21 posts,
feeds, likes, saves, shares and comments, 22 videos and reels (uploads read `postman/fixtures/`),
23 notifications and settings (the runner can't open WebSockets: watch live events with `npm run ws:listen`),
24 block and mute, 25 search and hashtags, 26 reports and moderation. Folder 26's staff requests log in
with the collection variables `adminLogin` / `adminPassword` (locally: `dev_admin`, made with
`npm run user:role -- dev_admin ADMIN`); without them those requests are skipped. They make B a reviewer
and then a user again.
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
src/services/settingsService.js app settings (JSONB, defaults merged at read time)
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

Profile shape: `{ id, username, name, bio, avatarUrl, isPrivate, followersCount, followingCount, createdAt,
isMe, followStatus, followsYou, canViewContent, details, blockedByMe, mutedByMe }`. `details` has location, skills, preferred
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
| GET | `/posts/feed` | `?cursor&limit` | Your posts + approved posts of people you follow, newest first |
| GET | `/posts/explore` | `?category=A,B&city=X&cursor&limit` | Approved posts from public accounts |
| GET | `/posts/saved` | `?cursor&limit` | Newest save first |
| GET | `/posts/:postId` | – | |
| PATCH | `/posts/:postId` | any of `title, description, location, category, beneficiaries, hours` | Author only; sets `editedAt` |
| DELETE | `/posts/:postId` | – | Author only; deletes photos, likes, saves, comments |
| POST / DELETE | `/posts/:postId/like` | – | → `{ liked, likesCount }`, safe to repeat |
| GET | `/posts/:postId/likes` | `?cursor&limit` | Who liked it (user cards) |
| POST / DELETE | `/posts/:postId/save` | – | → `{ saved, savesCount }` |
| POST | `/posts/:postId/share` | – | → `{ sharesCount }` (counts share-sheet taps) |
| GET | `/posts/:postId/comments` | `?cursor&limit` | Top-level comments, oldest first, each with `repliesCount` |
| POST | `/posts/:postId/comments` | `text` (1–1000), `parentId?` | Reply to a reply attaches to the same top-level comment |
| GET | `/comments/:commentId/replies` | `?cursor&limit` | Oldest first |
| DELETE | `/comments/:commentId` | – | Comment author or post author; deletes its replies too |
| POST / DELETE | `/comments/:commentId/like` | – | → `{ liked, likesCount }` |
| GET | `/users/:user/posts` | `?cursor&limit` | Profile grid. The owner also sees posts under review |

Post shape: `{ id, author (user card), media: [{ id, type: 'image', url, width, height }], title,
description, location, category, beneficiaries, hours, status, likesCount, commentsCount, savesCount,
sharesCount, likedByMe, savedByMe, isMine, hashtags, createdAt, editedAt }`. `hashtags` are the `#tags`
found in the title and description (lower-case, without `#`). `status` is `APPROVED`,
`UNDER_REVIEW` or `REJECTED` (the app shows "Approved", "Under Review", "Rejected").
Categories: Health, Animal Welfare, Hunger & Poverty, Drug Prevention, Education, Gender Equality,
Youth & Sports, Child Rights, Environment.

Comment shape: `{ id, postId, parentId, text, author, likesCount, likedByMe, repliesCount, createdAt, canDelete }`.

Who sees a post (`postService.findVisiblePost` / `visibleTo`): its author always; others only when it is
APPROVED, the author is active, there is no block between them, and the author's profile is visible to
them (public, or approved follower). `POST_AUTO_APPROVE=true` (the default) approves posts on creation;
set it to `false` once reviewers work the queue (see "Reports & moderation"). Editing a rejected post
always sends it back to review.

| HTTP | `code` | Meaning |
|---|---|---|
| 404 | `POST_NOT_FOUND`, `COMMENT_NOT_FOUND` | doesn't exist or you can't see it |
| 403 | `PRIVATE_ACCOUNT` | private author you don't follow |
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
| GET | `/settings` | – | → `{ settings }`: the app's notification settings, defaults filled in |
| PATCH | `/settings` | any of the keys below | Merged into what is stored; unknown keys/values → 400 |

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

Undoing an action deletes its notification (unlike, unfollow, cancelled request, deleted comment or post).
Repeating an action never makes a second one. You're never notified about your own actions.

**Settings only decide whether the app shows a phone banner** (the `alert` field below). The Activity list
always shows everything (like Instagram). Keys (same as the app's `settingsSlice`): `pauseAll`,
`notifLikes` / `notifComments` / `notifMentions` (`'off' | 'following' | 'everyone'`), `notifNewFollowers`,
`notifFollowRequests`, `notifActivityApproved`, `notifActivityReminders`, `notifNearbyOpportunities`,
`notifAnnouncements`, `emailWeeklyDigest`, `emailOpportunities`, `emailProductUpdates`, `notifSound`,
`notifVibrate`, `quietHours` (22:00–07:00 in `DEFAULT_TIMEZONE`: banner on the `silent` channel). Mentions,
reminders, nearby, announcements and the email keys are stored for later features.

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
| POST | `/reports` | `type` (`post` \| `comment` \| `user`), `targetId` (an id, or a username for users), `reason`, `details?` (≤500) | 201, or 200 with `alreadyReported: true` if your report on it is still open. Only what you can see; never yourself |
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
| DELETE | `/admin/comments/:commentId` | `reason` | staff | Deletes it and its replies; the text is kept in the audit log |
| GET | `/admin/reports` | `?status=open\|resolved\|dismissed` (default open), `type?`, `cursor`, `limit` | staff | Oldest first, with reporter, target and `openReportsOnTarget` |
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

## Prisma 7 notes

- `prisma migrate dev` does **not** regenerate the client. Run `npm run db:generate` after every
  migration, or the server fails on startup with "Unknown field".

- The connection URL lives in `prisma.config.js`, not `schema.prisma`.
- Prisma 7 does not load `.env` by itself; `dotenv/config` does it.
- The client is generated into `src/generated/prisma`; import it from `src/lib/prisma.js`.
- The npm `latest` tag for the `prisma` CLI points at an 8.0 RC. Keep `prisma` and
  `@prisma/client` pinned to the same stable 7.x version.
