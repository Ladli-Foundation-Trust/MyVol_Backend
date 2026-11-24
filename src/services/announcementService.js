const crypto = require('crypto');
const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const { toAnnouncementImage } = require('../lib/images');
const AppError = require('../utils/appError');
const notifications = require('./notificationService');

// Announcements: one message from the MyVol team to many members (admin panel, D84).
//
// Sending = one ANNOUNCEMENT notification row per recipient, so it behaves like any
// other notification: it sits in the Activity list, arrives live over the WebSocket,
// and shows a phone banner (FCM) unless the member turned off "Announcements"
// (notifAnnouncements) or paused everything. Members who match the audience when it
// is SENT get it (a scheduled message reaches whoever matches at that time).
//
// The send is safe to repeat: rows are unique per (recipient, "announcement:<id>"), so
// the scheduler can resume one that a crash left half-sent.

const DAY_MS = 86_400_000;
const BATCH = 1000;
// A send that has been SENDING this long is treated as crashed and resumed.
const STALE_SENDING_MS = 10 * 60 * 1000;

const notFound = () => new AppError('Announcement not found', 404, undefined, 'ANNOUNCEMENT_NOT_FOUND');
const ago = (days) => new Date(Date.now() - days * DAY_MS);

const log = (db, moderatorId, action, id, reason, metadata) =>
    db.moderationAction.create({ data: { moderatorId, action, targetType: 'announcement', targetId: id, reason, metadata } });

// ---------- picture ----------

// Uploaded before the announcement is written (the panel shows it in the preview).
// The size is part of the key, so the API can lay it out without reading the file,
// whatever storage holds it: announcements/<uuid>_<width>x<height>.jpg
const IMAGE_KEY = /^announcements\/[0-9a-f-]{36}_(\d{1,5})x(\d{1,5})\.jpg$/;

const uploadImage = async (file) => {
    const { buffer, width, height } = await toAnnouncementImage(file.buffer);
    const imageKey = `announcements/${crypto.randomUUID()}_${width}x${height}.jpg`;
    await storage.save(imageKey, buffer);
    return { imageKey, imageUrl: storage.urlFor(imageKey), width, height, bytes: buffer.length };
};

const imageFields = async (imageKey) => {
    if (!imageKey) return { imageKey: null, imageWidth: null, imageHeight: null };
    const m = IMAGE_KEY.exec(imageKey);
    if (!m || !(await storage.exists(imageKey))) {
        throw new AppError('That picture was not found. Upload it again.', 400, undefined, 'IMAGE_NOT_FOUND');
    }
    return { imageKey, imageWidth: Number(m[1]), imageHeight: Number(m[2]) };
};

// Pictures uploaded but never used in an announcement (the admin changed their mind),
// after a day. Pictures of any announcement, even cancelled or withdrawn, are kept.
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const removeOrphanImages = async () => {
    const files = (await storage.list('announcements')).filter((f) => Date.now() - f.modifiedAt.getTime() > ORPHAN_AGE_MS);
    if (files.length === 0) return 0;
    const used = await prisma.announcement.findMany({ where: { imageKey: { in: files.map((f) => f.key) } }, select: { imageKey: true } });
    const keep = new Set(used.map((u) => u.imageKey));
    const orphans = files.filter((f) => !keep.has(f.key));
    await Promise.all(orphans.map((f) => storage.remove(f.key)));
    return orphans.length;
};

// ---------- audience ----------

// The saved filter → which ACTIVE accounts get it. Every part is optional; they combine
// with AND. Empty = every active member.
const audienceWhere = (a = {}) => ({
    AND: [
        { status: 'ACTIVE' },
        a.userIds?.length ? { id: { in: a.userIds } } : {},
        a.roles?.length ? { role: { in: a.roles } } : {},
        a.city ? { profile: { city: { contains: a.city, mode: 'insensitive' } } } : {},
        a.causes?.length ? { profile: { preferredAreas: { hasSome: a.causes } } } : {},
        a.joinedWithinDays ? { createdAt: { gte: ago(a.joinedWithinDays) } } : {},
        a.activeWithinDays ? { sessions: { some: { lastUsedAt: { gte: ago(a.activeWithinDays) } } } } : {},
        a.inactiveForDays ? { sessions: { none: { lastUsedAt: { gte: ago(a.inactiveForDays) } } } } : {},
    ],
});

// Plain words for the panel ("Members in Pune who care about Education").
const describeAudience = (a = {}) => {
    if (a.userIds?.length) return a.userIds.length === 1 ? '1 chosen person' : `${a.userIds.length} chosen people`;
    const parts = [];
    if (a.roles?.length) parts.push(a.roles.map((r) => ({ USER: 'members', REVIEWER: 'reviewers', ADMIN: 'admins' })[r]).join(' and '));
    if (a.city) parts.push(`in ${a.city}`);
    if (a.causes?.length) parts.push(`who care about ${a.causes.join(' or ')}`);
    if (a.joinedWithinDays) parts.push(`who joined in the last ${a.joinedWithinDays} days`);
    if (a.activeWithinDays) parts.push(`active in the last ${a.activeWithinDays} days`);
    if (a.inactiveForDays) parts.push(`not seen for ${a.inactiveForDays}+ days`);
    return parts.length ? `Everyone ${parts.join(', ')}` : 'Everyone';
};

// How many would get it right now, and how many of them will see a phone banner
// (have notifications on a phone and haven't switched announcements off).
const audienceCount = async (audience) => {
    const where = audienceWhere(audience);
    const [count, withPush, optedOut] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.count({ where: { AND: [where, { pushTokens: { some: { session: { revokedAt: null, expiresAt: { gt: new Date() } } } } }] } }),
        prisma.user.count({
            where: {
                AND: [
                    where,
                    {
                        settings: {
                            OR: [{ data: { path: ['notifAnnouncements'], equals: false } }, { data: { path: ['pauseAll'], equals: true } }],
                        },
                    },
                ],
            },
        }),
    ]);
    return { count, withPush, optedOut, description: describeAudience(audience) };
};

// ---------- sending ----------

// Claims the announcement for sending (only one sender wins), then writes the rows in
// batches and delivers them in the background.
const send = async (id) => {
    const { count: claimed } = await prisma.announcement.updateMany({
        where: {
            id,
            OR: [{ status: 'SCHEDULED' }, { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } }],
        },
        data: { status: 'SENDING' },
    });
    if (!claimed) return null;

    const a = await prisma.announcement.findUnique({ where: { id } });
    const where = audienceWhere(a.audience);
    const dedupeKey = notifications.keys.announcement(id);
    const created = [];
    let cursor;
    for (;;) {
        const users = await prisma.user.findMany({
            where,
            select: { id: true },
            orderBy: { id: 'asc' },
            take: BATCH,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        });
        if (users.length === 0) break;
        const rows = users.map((u) => ({ id: crypto.randomUUID(), type: 'ANNOUNCEMENT', recipientId: u.id, announcementId: id, dedupeKey }));
        await prisma.notification.createMany({ data: rows, skipDuplicates: true });
        created.push(...rows.map((r) => r.id));
        cursor = users.at(-1).id;
        // Keeps the claim fresh on very large sends.
        await prisma.announcement.update({ where: { id }, data: { status: 'SENDING' } });
    }

    const recipients = await prisma.notification.count({ where: { announcementId: id } });
    await prisma.announcement.update({ where: { id }, data: { status: 'SENT', sentAt: a.sentAt ?? new Date(), recipientsCount: recipients } });
    // Rows that already existed (a resumed send) were skipped by createMany; delivering
    // their new ids is a harmless no-op because sendOne finds nothing.
    notifications.deliverInBatches(created);
    return recipients;
};

// The scheduler (server.js, every minute): sends what is due, and resumes a send that
// a crash left in SENDING.
const sendDue = async () => {
    const due = await prisma.announcement.findMany({
        where: {
            OR: [
                { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
                { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
            ],
        },
        select: { id: true },
        orderBy: { scheduledAt: 'asc' },
        take: 20,
    });
    for (const { id } of due) {
        try {
            await send(id);
        } catch (err) {
            console.error(`[announcements] ${id} failed:`, err.message);
        }
    }
    return due.length;
};

// ---------- admin actions ----------

// { title, body, linkUrl?, audience, sendAt?, test? }. test = only to the author.
const create = async (adminId, { title, body, linkUrl, imageKey, audience = {}, sendAt, test = false }) => {
    const image = await imageFields(imageKey);
    const finalAudience = test ? { userIds: [adminId] } : audience;
    const scheduled = !test && sendAt && sendAt > new Date();
    const a = await prisma.$transaction(async (tx) => {
        const row = await tx.announcement.create({
            data: {
                title,
                body,
                linkUrl: linkUrl || null,
                ...image,
                audience: finalAudience,
                isTest: test,
                scheduledAt: scheduled ? sendAt : new Date(),
                createdById: adminId,
            },
        });
        if (!test) {
            await log(tx, adminId, scheduled ? 'SCHEDULE_ANNOUNCEMENT' : 'SEND_ANNOUNCEMENT', row.id, title, {
                audience: describeAudience(finalAudience),
                ...(scheduled && { sendAt }),
            });
        }
        return row;
    });
    if (!scheduled) await send(a.id);
    return getAnnouncement(a.id);
};

const findOr404 = async (id) => {
    const a = await prisma.announcement.findUnique({ where: { id } });
    if (!a) throw notFound();
    return a;
};

const cancel = async (adminId, id) => {
    const a = await findOr404(id);
    const { count } = await prisma.announcement.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    if (!count) throw new AppError('Only a scheduled announcement can be cancelled', 409, undefined, 'NOT_SCHEDULED');
    await log(prisma, adminId, 'CANCEL_ANNOUNCEMENT', id, a.title);
    return getAnnouncement(id);
};

const sendNow = async (adminId, id) => {
    const a = await findOr404(id);
    if (a.status !== 'SCHEDULED') throw new AppError('Only a scheduled announcement can be sent now', 409, undefined, 'NOT_SCHEDULED');
    await prisma.announcement.update({ where: { id }, data: { scheduledAt: new Date() } });
    await log(prisma, adminId, 'SEND_ANNOUNCEMENT', id, a.title, { audience: describeAudience(a.audience), early: true });
    await send(id);
    return getAnnouncement(id);
};

// Takes a sent announcement back out of every Activity list (a mistake, wrong link).
// Phone banners already shown can't be recalled.
const withdraw = async (adminId, id, { reason }) => {
    const a = await findOr404(id);
    if (a.status !== 'SENT') throw new AppError('Only a sent announcement can be withdrawn', 409, undefined, 'NOT_SENT');
    const recipients = await notifications.recipientsOf(prisma, { announcementId: id, readAt: null });
    await prisma.$transaction(async (tx) => {
        await tx.notification.deleteMany({ where: { announcementId: id } });
        await tx.announcement.update({ where: { id }, data: { status: 'WITHDRAWN', withdrawnAt: new Date() } });
        await log(tx, adminId, 'WITHDRAW_ANNOUNCEMENT', id, reason, { title: a.title });
    });
    // Their unread badge drops on open devices.
    notifications.syncCount(recipients);
    return getAnnouncement(id);
};

// ---------- reading ----------

const shape = (a, reads = 0) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    linkUrl: a.linkUrl,
    imageKey: a.imageKey,
    imageUrl: storage.urlFor(a.imageKey),
    imageWidth: a.imageWidth,
    imageHeight: a.imageHeight,
    audience: a.audience,
    audienceDescription: describeAudience(a.audience),
    status: a.status,
    isTest: a.isTest,
    scheduledAt: a.scheduledAt,
    sentAt: a.sentAt,
    withdrawnAt: a.withdrawnAt,
    recipientsCount: a.recipientsCount,
    readCount: reads,
    // Read rate only means something while the rows exist (they age out after
    // NOTIFICATION_RETENTION_DAYS, and withdrawing deletes them).
    readRate: a.recipientsCount ? Math.round((reads / a.recipientsCount) * 100) : 0,
    createdBy: a.createdBy ?? null,
    createdAt: a.createdAt,
});

const AUTHOR = { createdBy: { select: { id: true, username: true, name: true } } };

const readsFor = async (ids) => {
    if (ids.length === 0) return new Map();
    const rows = await prisma.notification.groupBy({ by: ['announcementId'], where: { announcementId: { in: ids }, readAt: { not: null } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.announcementId, r._count._all]));
};

const listAnnouncements = async ({ status, page, pageSize }) => {
    const where = status ? { status } : {};
    const [total, rows, counts] = await Promise.all([
        prisma.announcement.count({ where }),
        prisma.announcement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: AUTHOR }),
        prisma.announcement.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const reads = await readsFor(rows.map((r) => r.id));
    return {
        items: rows.map((a) => shape(a, reads.get(a.id) ?? 0)),
        total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(total / pageSize)),
        byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
};

const getAnnouncement = async (id) => {
    const a = await prisma.announcement.findUnique({ where: { id }, include: AUTHOR });
    if (!a) throw notFound();
    const [reads, delivered] = await Promise.all([
        readsFor([id]),
        // Reads per day since it went out, for the panel's chart.
        a.sentAt
            ? prisma.$queryRaw`SELECT to_char(read_at, 'YYYY-MM-DD') AS date, count(*)::int AS n FROM notifications
                               WHERE announcement_id = ${id}::uuid AND read_at IS NOT NULL GROUP BY 1 ORDER BY 1`
            : [],
    ]);
    return { announcement: { ...shape(a, reads.get(id) ?? 0), readsByDay: delivered } };
};

module.exports = { uploadImage, removeOrphanImages, audienceWhere, describeAudience, audienceCount, send, sendDue, create, cancel, sendNow, withdraw, listAnnouncements, getAnnouncement };
