const crypto = require('crypto');
const fs = require('fs/promises');
const prisma = require('../lib/prisma');
const env = require('../config/env');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const { toPostImage } = require('../lib/images');
const { processVideo } = require('../lib/videos');
const { afterCursor, toPage } = require('../utils/cursor');
const { CARD_SELECT, notBlockedWith, findActiveUser, relationsFor, canView, toCard } = require('./socialGraph');

// Stories, as in the app's storiesSlice: one photo or clip with an optional caption,
// gone STORY_LIFETIME_HOURS after it was shared. Not reviewed, liked or commented on,
// never in the feed or the grid. Who may see them is the profile rule (socialGraph
// canView: public, or an approved follower; nothing across a block). The tray (the
// Home rail) shows you and the people you follow and haven't muted, people with
// unwatched stories first. Expired stories are filtered out on every read and
// deleted, with their files, by the cleanup job.

const AUTHOR = { select: { ...CARD_SELECT, status: true } };

const live = () => ({ expiresAt: { gt: new Date() } });

const storyNotFound = () => new AppError('Story not found', 404, undefined, 'STORY_NOT_FOUND');

const fileKeys = (story) => [story.key, story.thumbnailKey].filter(Boolean);

const removeFiles = (keys) =>
    Promise.all(keys.map((key) => storage.remove(key).catch((err) => console.error('[storage] could not delete', key, err.message))));

// ---------- response shape ----------

// `seen` for the viewer in one query for the whole list. The view count is the
// author's business only.
const toStories = async (viewerId, stories) => {
    if (stories.length === 0) return [];
    const views = await prisma.storyView.findMany({
        where: { viewerId, storyId: { in: stories.map((s) => s.id) } },
        select: { storyId: true },
    });
    const seen = new Set(views.map((v) => v.storyId));
    const rel = await relationsFor(viewerId, [...new Set(stories.map((s) => s.authorId))]);

    return stories.map((s) => {
        const isMine = s.authorId === viewerId;
        return {
            id: s.id,
            author: toCard(s.author, viewerId, rel),
            type: s.type.toLowerCase(),
            url: storage.urlFor(s.key),
            thumbnailUrl: storage.urlFor(s.thumbnailKey),
            width: s.width,
            height: s.height,
            durationMs: s.durationMs,
            caption: s.caption,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            seen: isMine || seen.has(s.id),
            isMine,
            ...(isMine && { viewsCount: s.viewsCount }),
        };
    });
};

// ---------- create / delete ----------

// The file is processed and stored first; if saving the row fails, the files go again.
const createStory = async (authorId, { caption }, file) => {
    const id = crypto.randomUUID();
    let row;
    let files;
    if (file.mimetype?.startsWith('video/')) {
        const video = await processVideo(file.path, { maxSeconds: env.STORY_MAX_VIDEO_SECONDS });
        files = [
            [`stories/${id}.mp4`, video.buffer],
            [`stories/${id}.webp`, video.thumbnail],
        ];
        row = { type: 'VIDEO', key: `stories/${id}.mp4`, thumbnailKey: `stories/${id}.webp`, width: video.width, height: video.height, durationMs: video.durationMs };
    } else {
        if (file.size > env.MAX_POST_IMAGE_MB * 1024 * 1024) {
            throw new AppError(`Photos can be at most ${env.MAX_POST_IMAGE_MB} MB`, 413, undefined, 'FILE_TOO_LARGE');
        }
        const image = await toPostImage(await fs.readFile(file.path));
        files = [[`stories/${id}.webp`, image.buffer]];
        row = { type: 'IMAGE', key: `stories/${id}.webp`, width: image.width, height: image.height };
    }

    const saved = [];
    try {
        for (const [key, buffer] of files) {
            await storage.save(key, buffer);
            saved.push(key);
        }
        const story = await prisma.story.create({
            data: {
                id,
                authorId,
                ...row,
                caption: caption || null,
                expiresAt: new Date(Date.now() + env.STORY_LIFETIME_HOURS * 3_600_000),
            },
            include: { author: AUTHOR },
        });
        return (await toStories(authorId, [story]))[0];
    } catch (err) {
        await removeFiles(saved);
        throw err;
    }
};

// Removes the row (its views and reports' links go with it) and then the files. Used
// by the author and by moderators (moderationService.resolveReport).
const removeStory = async (story) => {
    await prisma.story.delete({ where: { id: story.id } });
    await removeFiles(fileKeys(story));
};

const deleteStory = async (viewerId, storyId) => {
    const story = await prisma.story.findUnique({ where: { id: storyId } });
    if (!story) throw storyNotFound();
    if (story.authorId !== viewerId) throw new AppError('Only the author can do this', 403, undefined, 'NOT_AUTHOR');
    await removeStory(story);
};

// ---------- visibility ----------

// A live story the viewer may see: always their own; anyone else's only if its author
// is active, there is no block (404) and the profile is visible to them (403).
const findVisibleStory = async (viewerId, storyId) => {
    const story = await prisma.story.findFirst({ where: { id: storyId, ...live() }, include: { author: AUTHOR } });
    if (!story) throw storyNotFound();
    if (story.authorId === viewerId) return story;
    if (story.author.status !== 'ACTIVE') throw storyNotFound();

    const relation = (await relationsFor(viewerId, [story.authorId]))(story.authorId);
    if (relation.blockedByMe || relation.blocksMe) throw storyNotFound();
    if (!canView(viewerId, story.author, relation)) {
        throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');
    }
    return story;
};

const getStory = async (viewerId, storyId) => (await toStories(viewerId, [await findVisibleStory(viewerId, storyId)]))[0];

// ---------- reading ----------

// One person's live stories, oldest first (the order they play in).
const userStories = async (viewerId, idOrUsername) => {
    const user = await findActiveUser(idOrUsername, { viewerId });
    const rel = await relationsFor(viewerId, [user.id]);
    const relation = rel(user.id);
    if (relation.blockedByMe) throw new AppError('Unblock this account to see it', 403, undefined, 'USER_BLOCKED');
    if (!canView(viewerId, user, relation)) throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');

    const stories = await prisma.story.findMany({
        where: { authorId: user.id, ...live() },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { author: AUTHOR },
    });
    return { user: toCard(user, viewerId, rel), stories: await toStories(viewerId, stories) };
};

// The Home rail: you (if you have a live story) and the people you follow (not muted)
// with something live, as { user, storiesCount, hasUnseen, latestAt }. Your own bubble
// first, then people with unwatched stories, then the most recently updated (the order
// the app's selectStoryRail uses).
const tray = async (viewerId) => {
    const stories = await prisma.story.findMany({
        where: {
            ...live(),
            author: { status: 'ACTIVE' },
            OR: [
                { authorId: viewerId },
                { author: { followers: { some: { followerId: viewerId } }, mutesReceived: { none: { muterId: viewerId } } } },
            ],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, authorId: true, createdAt: true },
    });
    if (stories.length === 0) return { tray: [] };

    const authorIds = [...new Set(stories.map((s) => s.authorId))];
    const [views, authors, rel] = await Promise.all([
        prisma.storyView.findMany({ where: { viewerId, storyId: { in: stories.map((s) => s.id) } }, select: { storyId: true } }),
        prisma.user.findMany({ where: { id: { in: authorIds } }, select: CARD_SELECT }),
        relationsFor(viewerId, authorIds),
    ]);
    const seen = new Set(views.map((v) => v.storyId));

    const byAuthor = new Map();
    for (const s of stories) {
        const entry = byAuthor.get(s.authorId) ?? { storiesCount: 0, hasUnseen: false, latestAt: s.createdAt };
        entry.storiesCount += 1;
        entry.latestAt = s.createdAt; // oldest first, so the last one wins
        if (s.authorId !== viewerId && !seen.has(s.id)) entry.hasUnseen = true;
        byAuthor.set(s.authorId, entry);
    }

    const cards = new Map(authors.map((a) => [a.id, a]));
    const entries = [...byAuthor.entries()]
        .filter(([id]) => cards.has(id))
        .map(([id, e]) => ({ user: toCard(cards.get(id), viewerId, rel), ...e }));
    entries.sort(
        (a, b) => Number(b.user.isMe) - Number(a.user.isMe) || Number(b.hasUnseen) - Number(a.hasUnseen) || b.latestAt - a.latestAt,
    );
    return { tray: entries };
};

// For a profile header's ring: how many live stories, and whether any is unwatched.
const storySummary = async (viewerId, userId) => {
    const stories = await prisma.story.findMany({ where: { authorId: userId, ...live() }, select: { id: true } });
    if (stories.length === 0) return { count: 0, hasUnseen: false };
    if (userId === viewerId) return { count: stories.length, hasUnseen: false };
    const seen = await prisma.storyView.count({ where: { viewerId, storyId: { in: stories.map((s) => s.id) } } });
    return { count: stories.length, hasUnseen: seen < stories.length };
};

// ---------- seen & viewers ----------

// The app calls this when a story is shown. First time per viewer: +1 view. The
// author's own views are not counted. Repeating it is harmless.
const markSeen = async (viewerId, storyId) => {
    const story = await findVisibleStory(viewerId, storyId);
    if (story.authorId !== viewerId) {
        await prisma.$transaction(async (tx) => {
            const { count } = await tx.storyView.createMany({ data: [{ storyId, viewerId }], skipDuplicates: true });
            if (count) await tx.story.update({ where: { id: storyId }, data: { viewsCount: { increment: 1 } }, select: { id: true } });
        });
    }
    return { seen: true };
};

// Who watched your story, newest first (the author only). People with a block between
// you are left out, like everywhere else.
const listViewers = async (viewerId, storyId, { cursor, limit }) => {
    const story = await prisma.story.findFirst({ where: { id: storyId, ...live() }, select: { authorId: true, viewsCount: true } });
    if (!story) throw storyNotFound();
    if (story.authorId !== viewerId) throw new AppError('Only the author can see who viewed a story', 403, undefined, 'NOT_AUTHOR');

    const rows = await prisma.storyView.findMany({
        where: { storyId, viewer: { status: 'ACTIVE', ...notBlockedWith(viewerId) }, ...afterCursor(cursor, 'viewerId') },
        orderBy: [{ createdAt: 'desc' }, { viewerId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, viewerId: true, viewer: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'viewerId');
    const rel = await relationsFor(viewerId, items.map((r) => r.viewerId));
    return {
        viewsCount: story.viewsCount,
        viewers: items.map((r) => ({ ...toCard(r.viewer, viewerId, rel), viewedAt: r.createdAt })),
        nextCursor,
    };
};

module.exports = {
    createStory,
    deleteStory,
    removeStory,
    findVisibleStory,
    getStory,
    userStories,
    tray,
    storySummary,
    markSeen,
    listViewers,
};
