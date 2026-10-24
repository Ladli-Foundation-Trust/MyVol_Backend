const crypto = require('crypto');
const prisma = require('../lib/prisma');
const env = require('../config/env');
const realtime = require('../lib/realtime');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const { CARD_SELECT, relationsFor, isBlockedBetween, toCard } = require('./socialGraph');
const { getSettings } = require('./settingsService');
const { tierById } = require('../config/medals');

// The Activity tab, delivered live over our own WebSocket (lib/realtime.js).
//
// 1. Recording: the follow/post/comment services call the event functions below
//    INSIDE their own transaction, so a like and its notification commit together.
//    New events return the notification's id (or null: self-action or duplicate);
//    undo events return the user ids whose unread count may have changed.
// 2. Delivery: after the transaction commits, the caller passes those to deliver()
//    (new notifications) or syncCount() (counts). Both send in the background to the
//    recipient's connected devices; a device that isn't connected catches up from
//    GET /notifications when the app opens.
//
// Settings decide only whether the app should show a phone banner for a notification
// (the `alert` field); the in-app list always has everything (like Instagram). Undoing
// an action (unlike, unfollow, cancel) deletes its row.

// The app's custom URL scheme (MyVolApp src/config/linking.js): taps open these.
const APP_SCHEME = 'myvolapp';

// What the API calls each type. The app's Activity screen picks icons by these.
const TYPE_NAMES = {
    FOLLOW: 'follow',
    FOLLOW_REQUEST: 'follow_request',
    FOLLOW_ACCEPTED: 'follow_accepted',
    POST_LIKE: 'like',
    POST_COMMENT: 'comment',
    COMMENT_REPLY: 'reply',
    COMMENT_LIKE: 'comment_like',
    POST_APPROVED: 'approved',
    POST_REJECTED: 'rejected',
    MEDAL_EARNED: 'medal',
};

// The setting (settingsService) that controls the phone banner for each type.
const ALERT_SETTING = {
    FOLLOW: 'notifNewFollowers',
    FOLLOW_REQUEST: 'notifFollowRequests',
    FOLLOW_ACCEPTED: 'notifFollowRequests',
    POST_LIKE: 'notifLikes',
    COMMENT_LIKE: 'notifLikes',
    POST_COMMENT: 'notifComments',
    COMMENT_REPLY: 'notifComments',
    POST_APPROVED: 'notifActivityApproved',
    POST_REJECTED: 'notifActivityApproved',
    // A medal comes from an approval, so the same switch covers it.
    MEDAL_EARNED: 'notifActivityApproved',
};

// Unique per recipient: the same event can't be recorded twice.
const keys = {
    // Shared by FOLLOW and FOLLOW_REQUEST: accepting a request turns the one row into the other.
    follow: (actorId) => `follow:${actorId}`,
    followAccepted: (actorId) => `follow_accepted:${actorId}`,
    like: (postId, actorId) => `like:${postId}:${actorId}`,
    comment: (commentId) => `comment:${commentId}`,
    commentLike: (commentId, actorId) => `comment_like:${commentId}:${actorId}`,
    review: (postId) => `review:${postId}`,
    medal: (tierId) => `medal:${tierId}`,
};

// ---------- recording (always inside the caller's transaction `tx`) ----------

const create = async (tx, data) => {
    if (!data.recipientId || data.recipientId === data.actorId) return null; // nobody is notified about themself
    if (data.actorId && (await isBlockedBetween(data.actorId, data.recipientId, tx))) return null;
    const id = crypto.randomUUID();
    const { count } = await tx.notification.createMany({ data: [{ id, ...data }], skipDuplicates: true });
    return count ? id : null;
};

// Deletes and returns the recipients whose rows went (for syncCount).
const removeWhere = async (tx, where) => {
    const rows = await tx.notification.findMany({ where, select: { recipientId: true } });
    if (rows.length === 0) return [];
    await tx.notification.deleteMany({ where });
    return [...new Set(rows.map((r) => r.recipientId))];
};

// Who has notifications matching `where`: call BEFORE deleting a post or comment (their
// notifications go by cascade), then syncCount() them after the commit.
const recipientsOf = async (db, where) => {
    const rows = await db.notification.findMany({ where, distinct: ['recipientId'], select: { recipientId: true } });
    return rows.map((r) => r.recipientId);
};

const followed = (tx, actorId, targetId) =>
    create(tx, { type: 'FOLLOW', recipientId: targetId, actorId, dedupeKey: keys.follow(actorId) });

const followRequested = (tx, actorId, targetId) =>
    create(tx, { type: 'FOLLOW_REQUEST', recipientId: targetId, actorId, dedupeKey: keys.follow(actorId) });

// Unfollow, cancelled request or declined request: the target's "followed you" /
// "requested" row goes, and so does the actor's "accepted your request", so a later
// request + accept notifies again.
const followRemoved = (tx, actorId, targetId) =>
    removeWhere(tx, {
        OR: [
            { recipientId: targetId, dedupeKey: keys.follow(actorId) },
            { recipientId: actorId, dedupeKey: keys.followAccepted(targetId) },
        ],
    });

// The target's "requested to follow you" becomes "started following you", already
// read (they just acted on it), and the requester hears back.
const requestAccepted = async (tx, requesterId, targetId) => {
    await tx.notification.updateMany({
        where: { recipientId: targetId, dedupeKey: keys.follow(requesterId), type: 'FOLLOW_REQUEST' },
        data: { type: 'FOLLOW', readAt: new Date() },
    });
    return create(tx, { type: 'FOLLOW_ACCEPTED', recipientId: requesterId, actorId: targetId, dedupeKey: keys.followAccepted(targetId) });
};

// The account went public and every pending request was approved at once.
const allRequestsAccepted = (tx, targetId) =>
    tx.notification.updateMany({ where: { recipientId: targetId, type: 'FOLLOW_REQUEST' }, data: { type: 'FOLLOW' } });

const postLiked = (tx, actorId, post) =>
    create(tx, { type: 'POST_LIKE', recipientId: post.authorId, actorId, postId: post.id, dedupeKey: keys.like(post.id, actorId) });

const postUnliked = (tx, actorId, post) => removeWhere(tx, { recipientId: post.authorId, dedupeKey: keys.like(post.id, actorId) });

// One notification per person: the post's author ("commented") and the author of the
// comment being replied to ("replied to your comment"). Someone who is both gets the
// reply only. Deleting the comment deletes these (ON DELETE CASCADE).
const commented = async (tx, actorId, comment, { postAuthorId, repliedToAuthorId }) => {
    const base = { actorId, postId: comment.postId, commentId: comment.id, dedupeKey: keys.comment(comment.id) };
    const ids = [];
    if (repliedToAuthorId) ids.push(await create(tx, { ...base, type: 'COMMENT_REPLY', recipientId: repliedToAuthorId }));
    if (postAuthorId !== repliedToAuthorId) ids.push(await create(tx, { ...base, type: 'POST_COMMENT', recipientId: postAuthorId }));
    return ids;
};

const commentLiked = (tx, actorId, comment) =>
    create(tx, {
        type: 'COMMENT_LIKE',
        recipientId: comment.authorId,
        actorId,
        postId: comment.postId,
        commentId: comment.id,
        dedupeKey: keys.commentLike(comment.id, actorId),
    });

const commentUnliked = (tx, actorId, comment) =>
    removeWhere(tx, { recipientId: comment.authorId, dedupeKey: keys.commentLike(comment.id, actorId) });

// For the moderation phase: call after a reviewer approves or rejects `post`
// ({ id, authorId, status }). A second review replaces the first and is unread again.
// Not sent for POST_AUTO_APPROVE posts: those are live at once, nothing to announce.
const postReviewed = async (tx, post) => {
    const type = post.status === 'APPROVED' ? 'POST_APPROVED' : 'POST_REJECTED';
    const dedupeKey = keys.review(post.id);
    const row = await tx.notification.upsert({
        where: { recipientId_dedupeKey: { recipientId: post.authorId, dedupeKey } },
        create: { type, recipientId: post.authorId, postId: post.id, dedupeKey },
        update: { type, readAt: null, createdAt: new Date() },
        select: { id: true },
    });
    return row.id;
};

// impactService.checkMedal: the user just reached a tier. Once per tier, ever (until
// the row ages out after NOTIFICATION_RETENTION_DAYS), even if they drop below and
// reach it again.
const medalEarned = (tx, userId, tierId) => create(tx, { type: 'MEDAL_EARNED', recipientId: userId, dedupeKey: keys.medal(tierId) });

// ---------- reading ----------

const INCLUDE = {
    actor: { select: CARD_SELECT },
    post: {
        select: {
            id: true,
            title: true,
            rejectionReason: true,
            media: { orderBy: { position: 'asc' }, take: 1, select: { type: true, key: true, thumbnailKey: true } },
        },
    },
    comment: { select: { id: true, text: true } },
};

// Notifications from deactivated or suspended users are hidden (they come back if the
// account does), the same as those users' posts and comments.
const visibleWhere = (recipientId) => ({ recipientId, OR: [{ actorId: null }, { actor: { status: 'ACTIVE' } }] });

const notFound = () => new AppError('Notification not found', 404, undefined, 'NOTIFICATION_NOT_FOUND');

const snippet = (text, max = 80) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// Built at read time, so a renamed user or an edited title shows up correctly.
const messageFor = (n) => {
    const name = n.actor?.name;
    const title = n.post?.title;
    const text = n.comment ? snippet(n.comment.text) : '';
    switch (n.type) {
        case 'FOLLOW':
            return `${name} started following you.`;
        case 'FOLLOW_REQUEST':
            return `${name} requested to follow you.`;
        case 'FOLLOW_ACCEPTED':
            return `${name} accepted your follow request.`;
        case 'POST_LIKE':
            return `${name} liked your activity "${title}".`;
        case 'POST_COMMENT':
            return `${name} commented: ${text}`;
        case 'COMMENT_REPLY':
            return `${name} replied to your comment: ${text}`;
        case 'COMMENT_LIKE':
            return `${name} liked your comment: ${text}`;
        case 'POST_APPROVED':
            return `Your "${title}" activity was approved.`;
        case 'POST_REJECTED':
            return `Your "${title}" activity wasn't approved${n.post?.rejectionReason ? `: ${n.post.rejectionReason}` : '.'}`;
        case 'MEDAL_EARNED': {
            const tier = tierById(n.dedupeKey.slice('medal:'.length));
            return tier ? `You earned the ${tier.label} for ${tier.activities} approved activities.` : 'You earned a medal.';
        }
        default:
            return 'You have a new notification.';
    }
};

// Where tapping it goes: the post if there is one, otherwise the person (a medal opens
// your own profile, where the Impact tab is).
const urlFor = (n) => {
    if (n.type === 'MEDAL_EARNED') return `${APP_SCHEME}://user/${n.recipientId}`;
    if (n.postId) return `${APP_SCHEME}://post/${n.postId}`;
    if (n.actorId) return `${APP_SCHEME}://user/${n.actorId}`;
    return null;
};

const thumbnailUrl = (post) => {
    const first = post.media[0];
    if (!first) return null;
    return storage.urlFor(first.type === 'VIDEO' ? first.thumbnailKey : first.key);
};

const toNotification = (n, viewerId, rel) => ({
    id: n.id,
    type: TYPE_NAMES[n.type],
    message: messageFor(n),
    actor: n.actor ? toCard(n.actor, viewerId, rel) : null,
    post: n.post ? { id: n.post.id, title: n.post.title, thumbnailUrl: thumbnailUrl(n.post) } : null,
    comment: n.comment ? { id: n.comment.id, text: n.comment.text } : null,
    url: urlFor(n),
    read: Boolean(n.readAt),
    createdAt: n.createdAt,
});

const countUnread = (userId) => prisma.notification.count({ where: { ...visibleWhere(userId), readAt: null } });

// Newest first, cursor-paginated, with the unread count for the badge.
const listNotifications = async (userId, { cursor, limit }) => {
    const [rows, unreadCount] = await Promise.all([
        prisma.notification.findMany({
            where: { AND: [visibleWhere(userId), afterCursor(cursor, 'id')] },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            include: INCLUDE,
        }),
        countUnread(userId),
    ]);
    const { items, nextCursor } = toPage(rows, limit, 'id');
    // Follow state of each actor, for "Follow back" buttons.
    const rel = await relationsFor(userId, [...new Set(items.map((n) => n.actorId).filter(Boolean))]);
    return { notifications: items.map((n) => toNotification(n, userId, rel)), nextCursor, unreadCount };
};

const unreadCount = async (userId) => ({ unreadCount: await countUnread(userId) });

// Read/delete also update the user's OTHER devices (phone + tablet stay in step).
const markRead = async (userId, id) => {
    const { count } = await prisma.notification.updateMany({ where: { id, recipientId: userId, readAt: null }, data: { readAt: new Date() } });
    if (count === 0 && !(await prisma.notification.findFirst({ where: { id, recipientId: userId }, select: { id: true } }))) {
        throw notFound();
    }
    syncCount(userId);
    return unreadCount(userId);
};

// `before` (optional): only notifications created up to then, i.e. the ones the
// user has actually seen, so one arriving while they tap "Mark all read" stays unread.
const markAllRead = async (userId, { before } = {}) => {
    await prisma.notification.updateMany({
        where: { recipientId: userId, readAt: null, ...(before && { createdAt: { lte: before } }) },
        data: { readAt: new Date() },
    });
    syncCount(userId);
    return unreadCount(userId);
};

const deleteNotification = async (userId, id) => {
    const { count } = await prisma.notification.deleteMany({ where: { id, recipientId: userId } });
    if (count === 0) throw notFound();
    syncCount(userId);
    return unreadCount(userId);
};

// ---------- live delivery ----------

// 22:00–07:00 in DEFAULT_TIMEZONE (users don't have their own zone yet).
const inQuietHours = (date = new Date()) => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: env.DEFAULT_TIMEZONE }).format(date));
    return hour >= 22 || hour < 7;
};

const wantsAlert = async (n, prefs) => {
    if (prefs.pauseAll) return false;
    const pref = prefs[ALERT_SETTING[n.type]];
    if (pref === false || pref === 'off') return false;
    if (pref === 'following') {
        if (!n.actorId) return true;
        const follows = await prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: n.recipientId, followingId: n.actorId } },
            select: { createdAt: true },
        });
        return Boolean(follows);
    }
    return true;
};

// Like → unlike → like makes a new row each time; only the first one shows a banner
// within an hour. In memory (one instance), like the socket registry.
const REALERT_WINDOW_MS = 60 * 60 * 1000;
const lastAlerted = new Map();
const recentlyAlerted = (n) => {
    const key = `${n.recipientId}|${n.dedupeKey}`;
    const now = Date.now();
    if (now - (lastAlerted.get(key) ?? 0) < REALERT_WINDOW_MS) return true;
    lastAlerted.set(key, now);
    if (lastAlerted.size > 10_000) {
        for (const [k, at] of lastAlerted) if (now - at >= REALERT_WINDOW_MS) lastAlerted.delete(k);
    }
    return false;
};

// Android 8+ fixes sound and vibration per notification channel, so the settings pick
// one of four channels the app creates at startup (README). Quiet hours → silent.
const channelFor = (prefs, quiet) => {
    if (quiet) return 'silent';
    if (prefs.notifSound && prefs.notifVibrate) return 'default';
    if (prefs.notifSound) return 'sound-only';
    if (prefs.notifVibrate) return 'vibrate-only';
    return 'silent';
};

// How the app should show it as a phone notification, or null for "list/badge only".
const alertFor = async (n, prefs) => {
    if (!(await wantsAlert(n, prefs)) || recentlyAlerted(n)) return null;
    const quiet = prefs.quietHours && inQuietHours();
    return {
        sound: !quiet && prefs.notifSound,
        vibrate: !quiet && prefs.notifVibrate,
        channelId: channelFor(prefs, quiet),
    };
};

const sendOne = async (id) => {
    const n = await prisma.notification.findUnique({ where: { id }, include: { ...INCLUDE, recipient: { select: { status: true } } } });
    // Gone already (a quick unlike), or the recipient's account isn't active.
    if (!n || n.recipient.status !== 'ACTIVE') return;
    // Nobody online: the app picks it up from GET /notifications when it opens.
    if (realtime.connectedDevices(n.recipientId) === 0) return;

    const [prefs, rel, unread] = await Promise.all([
        getSettings(n.recipientId),
        relationsFor(n.recipientId, n.actorId ? [n.actorId] : []),
        countUnread(n.recipientId),
    ]);
    realtime.sendToUser(n.recipientId, {
        type: 'notification',
        notification: toNotification(n, n.recipientId, rel),
        unreadCount: unread,
        alert: await alertFor(n, prefs),
    });
};

const sendCount = async (userId) => {
    if (realtime.connectedDevices(userId) === 0) return;
    realtime.sendToUser(userId, { type: 'unread_count', unreadCount: await countUnread(userId) });
};

// Background sends in progress, so tests (and a graceful shutdown) can wait for them.
const inFlight = new Set();
const track = (job, what) => {
    const p = job.catch((err) => console.error(`[realtime] ${what} failed:`, err.message));
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
};

// Call AFTER the transaction that recorded the notifications has committed.
// Accepts an id, null, or an array of them.
const deliver = (ids) => {
    for (const id of [ids].flat().filter(Boolean)) track(sendOne(id), `notification ${id}`);
};

// Tells these users' devices their new unread count (after an undo, a read, a delete).
const syncCount = (userIds) => {
    for (const userId of new Set([userIds].flat().filter(Boolean))) track(sendCount(userId), `unread count for ${userId}`);
};

const settle = () => Promise.all([...inFlight]);

// "Send me a test notification": goes to every connected device whatever the
// settings, so a developer can check the app's socket + banner code.
const sendTest = (userId) => ({
    devices: realtime.sendToUser(userId, {
        type: 'test',
        message: 'Notifications are working.',
        alert: { sound: true, vibrate: true, channelId: 'default' },
    }),
});

module.exports = {
    TYPE_NAMES,
    // recording
    followed,
    followRequested,
    followRemoved,
    requestAccepted,
    allRequestsAccepted,
    postLiked,
    postUnliked,
    commented,
    commentLiked,
    commentUnliked,
    postReviewed,
    medalEarned,
    recipientsOf,
    // reading
    listNotifications,
    unreadCount,
    markRead,
    markAllRead,
    deleteNotification,
    // live delivery
    deliver,
    syncCount,
    settle,
    sendTest,
    inQuietHours,
};
