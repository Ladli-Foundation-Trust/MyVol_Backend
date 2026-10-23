const crypto = require('crypto');
const fs = require('fs/promises');
const prisma = require('../lib/prisma');
const env = require('../config/env');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const { toPostImage } = require('../lib/images');
const { processVideo } = require('../lib/videos');
const { afterCursor, toPage } = require('../utils/cursor');
const notifications = require('./notificationService');
const { CARD_SELECT, notBlockedWith, findActiveUser, relationsFor, canView, toCard } = require('./socialGraph');

// ---------- loading & visibility ----------

const POST_INCLUDE = {
    author: { select: { ...CARD_SELECT, status: true } },
    media: {
        orderBy: { position: 'asc' },
        select: { id: true, type: true, key: true, width: true, height: true, thumbnailKey: true, durationMs: true },
    },
    hashtags: { select: { hashtag: { select: { name: true } } } },
};

// Enough to decide whether someone may see or react to a post.
const ACCESS_SELECT = { id: true, authorId: true, status: true, author: { select: { id: true, isPrivate: true, status: true } } };

const postNotFound = () => new AppError('Post not found', 404, undefined, 'POST_NOT_FOUND');

// Who may see a post: its author always (any status). Anyone else only if it is
// APPROVED, the author is active, there is no block between them (404, as if it didn't
// exist) and the author's profile is visible to them (public, or approved follower:
// socialGraph.canView).
const findVisiblePost = async (viewerId, postId, query = { select: ACCESS_SELECT }) => {
    const post = await prisma.post.findUnique({ where: { id: postId }, ...query });
    if (!post) throw postNotFound();
    if (post.authorId === viewerId) return post;
    if (post.status !== 'APPROVED' || post.author.status !== 'ACTIVE') throw postNotFound();

    const relation = (await relationsFor(viewerId, [post.authorId]))(post.authorId);
    if (relation.blockedByMe || relation.blocksMe) throw postNotFound();
    if (!canView(viewerId, post.author, relation)) {
        throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');
    }
    return post;
};

// The same rule as a Prisma `where`, for lists of posts.
const visibleTo = (viewerId) => ({
    author: { status: 'ACTIVE', ...notBlockedWith(viewerId) },
    OR: [
        { authorId: viewerId },
        {
            status: 'APPROVED',
            author: { OR: [{ isPrivate: false }, { followers: { some: { followerId: viewerId } } }] },
        },
    ],
});

const findOwnPost = async (viewerId, postId) => {
    const post = await prisma.post.findUnique({ where: { id: postId }, include: { media: { select: { key: true, thumbnailKey: true } } } });
    if (!post) throw postNotFound();
    if (post.authorId !== viewerId) throw new AppError('Only the author can do this', 403, undefined, 'NOT_AUTHOR');
    return post;
};

// ---------- response shape ----------

// Posts as the app shows them, with likedByMe/savedByMe and the author's follow
// state, in three extra queries for the whole page.
const toPosts = async (viewerId, posts) => {
    if (posts.length === 0) return [];
    const ids = posts.map((p) => p.id);
    const [likes, saves, rel] = await Promise.all([
        prisma.postLike.findMany({ where: { userId: viewerId, postId: { in: ids } }, select: { postId: true } }),
        prisma.postSave.findMany({ where: { userId: viewerId, postId: { in: ids } }, select: { postId: true } }),
        relationsFor(viewerId, [...new Set(posts.map((p) => p.authorId))]),
    ]);
    const liked = new Set(likes.map((l) => l.postId));
    const saved = new Set(saves.map((s) => s.postId));

    return posts.map((p) => {
        const isMine = p.authorId === viewerId;
        return {
            id: p.id,
            author: toCard(p.author, viewerId, rel),
            media: p.media.map((m) => ({
                id: m.id,
                type: m.type.toLowerCase(),
                url: storage.urlFor(m.key),
                width: m.width,
                height: m.height,
                ...(m.type === 'VIDEO' && { thumbnailUrl: storage.urlFor(m.thumbnailKey), durationMs: m.durationMs }),
            })),
            isReel: p.isReel,
            title: p.title,
            description: p.description,
            location: p.location,
            category: p.category,
            beneficiaries: p.beneficiaries,
            hours: p.hours,
            hashtags: p.hashtags.map((h) => h.hashtag.name),
            status: p.status,
            ...(isMine && p.rejectionReason && { rejectionReason: p.rejectionReason }),
            likesCount: p.likesCount,
            commentsCount: p.commentsCount,
            savesCount: p.savesCount,
            sharesCount: p.sharesCount,
            viewsCount: p.viewsCount,
            likedByMe: liked.has(p.id),
            savedByMe: saved.has(p.id),
            isMine,
            createdAt: p.createdAt,
            editedAt: p.editedAt,
        };
    });
};

const pageOfPosts = async (viewerId, where, { cursor, limit }) => {
    const rows = await prisma.post.findMany({
        where: { AND: [where, afterCursor(cursor, 'id')] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: POST_INCLUDE,
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    return { posts: await toPosts(viewerId, items), nextCursor };
};

const removeFiles = (keys) =>
    Promise.all(keys.map((key) => storage.remove(key).catch((err) => console.error('[storage] could not delete', key, err.message))));

// ---------- hashtags ----------

// "#" + up to 50 letters (any script), combining marks, digits or "_", lower-cased, at
// most 30 per post. \p{M} matters: Hindi and other Indic scripts write vowel signs and
// the virama as combining marks, so without it "#स्वच्छता" would be cut to "#स".
const HASHTAG = /#([\p{L}\p{M}\p{N}_]{1,50})/gu;
const MAX_HASHTAGS = 30;

const extractHashtags = (...texts) => {
    const tags = new Set();
    for (const text of texts) for (const [, tag] of (text ?? '').matchAll(HASHTAG)) tags.add(tag.toLowerCase());
    return [...tags].slice(0, MAX_HASHTAGS);
};

const recountHashtags = (tx, hashtagIds) =>
    hashtagIds.length
        ? tx.$executeRaw`
              UPDATE hashtags h SET posts_count = (SELECT count(*) FROM post_hashtags ph WHERE ph.hashtag_id = h.id)
              WHERE h.id = ANY(${hashtagIds}::uuid[])`
        : null;

// Makes the post's hashtags exactly `names`, inside the caller's transaction.
const setPostHashtags = async (tx, postId, names) => {
    const before = await tx.postHashtag.findMany({ where: { postId }, select: { hashtagId: true } });
    await tx.postHashtag.deleteMany({ where: { postId } });
    let after = [];
    if (names.length) {
        await tx.hashtag.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true });
        after = await tx.hashtag.findMany({ where: { name: { in: names } }, select: { id: true } });
        await tx.postHashtag.createMany({ data: after.map((h) => ({ postId, hashtagId: h.id })) });
    }
    await recountHashtags(tx, [...new Set([...before, ...after].map((h) => h.hashtagId ?? h.id))]);
};

// ---------- create / edit / delete ----------

const mediaKeys = (media) => media.flatMap((m) => [m.key, m.thumbnailKey].filter(Boolean));

const isVideo = (file) => file.mimetype?.startsWith('video/');

// One uploaded file (on disk, from multer) -> a media row + the files to store.
// The real format is checked by the decoder (sharp / ffprobe), not the file name.
const processUpload = async (file, position) => {
    const id = crypto.randomUUID();
    if (isVideo(file)) {
        const video = await processVideo(file.path);
        return {
            files: [
                [`posts/${id}.mp4`, video.buffer],
                [`posts/${id}.webp`, video.thumbnail],
            ],
            row: {
                type: 'VIDEO',
                key: `posts/${id}.mp4`,
                thumbnailKey: `posts/${id}.webp`,
                width: video.width,
                height: video.height,
                durationMs: video.durationMs,
                position,
            },
        };
    }
    if (file.size > env.MAX_POST_IMAGE_MB * 1024 * 1024) {
        throw new AppError(`Photos can be at most ${env.MAX_POST_IMAGE_MB} MB`, 413, undefined, 'FILE_TOO_LARGE');
    }
    const image = await toPostImage(await fs.readFile(file.path));
    return {
        files: [[`posts/${id}.webp`, image.buffer]],
        row: { type: 'IMAGE', key: `posts/${id}.webp`, width: image.width, height: image.height, position },
    };
};

// Photos and videos are processed and saved first (videos one at a time, see
// lib/videos.js); if anything then fails, the saved files are deleted again.
// A post whose only item is a video is a reel.
const createPost = async (authorId, data, files = []) => {
    if (files.length === 0 && !data.description) {
        throw new AppError(
            'A post without photos needs a description',
            400,
            [{ field: 'description', message: 'is required when there are no photos' }],
            'DESCRIPTION_REQUIRED',
        );
    }

    const saved = [];
    try {
        const rows = [];
        for (const [i, file] of files.entries()) {
            const { files: outputs, row } = await processUpload(file, i);
            for (const [key, buffer] of outputs) {
                await storage.save(key, buffer);
                saved.push(key);
            }
            rows.push(row);
        }

        const post = await prisma.$transaction(async (tx) => {
            const created = await tx.post.create({
                data: {
                    authorId,
                    ...data,
                    status: env.POST_AUTO_APPROVE ? 'APPROVED' : 'UNDER_REVIEW',
                    isReel: rows.length === 1 && rows[0].type === 'VIDEO',
                    media: { create: rows },
                },
                select: { id: true },
            });
            await setPostHashtags(tx, created.id, extractHashtags(data.title, data.description));
            return tx.post.findUnique({ where: { id: created.id }, include: POST_INCLUDE });
        });
        return (await toPosts(authorId, [post]))[0];
    } catch (err) {
        await removeFiles(saved);
        throw err;
    }
};

// Text fields only (photos can't be swapped yet). Once moderation is on, an edited
// post goes back to review so approved content can't be changed afterwards. A rejected
// post always goes back to review when edited: fixing it is how the author appeals.
const updatePost = async (viewerId, postId, data) => {
    const post = await findOwnPost(viewerId, postId);
    const description = data.description !== undefined ? data.description : post.description;
    if (post.media.length === 0 && !description) {
        throw new AppError(
            'A post without photos needs a description',
            400,
            [{ field: 'description', message: 'is required when there are no photos' }],
            'DESCRIPTION_REQUIRED',
        );
    }

    const updated = await prisma.$transaction(async (tx) => {
        await tx.post.update({
            where: { id: postId },
            data: {
                ...data,
                editedAt: new Date(),
                ...((!env.POST_AUTO_APPROVE || post.status === 'REJECTED') && { status: 'UNDER_REVIEW', rejectionReason: null }),
            },
            select: { id: true },
        });
        if (data.title !== undefined || data.description !== undefined) {
            await setPostHashtags(tx, postId, extractHashtags(data.title ?? post.title, description));
        }
        return tx.post.findUnique({ where: { id: postId }, include: POST_INCLUDE });
    });
    return (await toPosts(viewerId, [updated]))[0];
};

// Likes, saves, comments, hashtag links and media rows go with it (ON DELETE CASCADE);
// files after.
const deletePost = async (viewerId, postId) => {
    const post = await findOwnPost(viewerId, postId);
    const changed = await prisma.$transaction(async (tx) => {
        const recipients = await notifications.recipientsOf(tx, { postId }); // their rows go by cascade
        const tags = await tx.postHashtag.findMany({ where: { postId }, select: { hashtagId: true } });
        await tx.post.delete({ where: { id: postId } });
        await recountHashtags(tx, tags.map((t) => t.hashtagId));
        return recipients;
    });
    notifications.syncCount(changed);
    await removeFiles(mediaKeys(post.media));
};

const getPost = async (viewerId, postId) => {
    const post = await findVisiblePost(viewerId, postId, { include: POST_INCLUDE });
    return (await toPosts(viewerId, [post]))[0];
};

// ---------- feeds (newest first, cursor-paginated) ----------

// Authors the viewer muted: their posts leave the feeds, but stay reachable on their
// profile, by link and in search (Instagram's behaviour).
const notMutedBy = (viewerId) => ({ mutesReceived: { none: { muterId: viewerId } } });

// Home: your own posts plus approved posts from people you follow (and haven't muted).
// Blocking removes follows both ways, so blocked people can't appear here.
const homeFeed = (viewerId, query) =>
    pageOfPosts(
        viewerId,
        {
            author: { status: 'ACTIVE' },
            OR: [
                { authorId: viewerId },
                { status: 'APPROVED', author: { followers: { some: { followerId: viewerId } }, ...notMutedBy(viewerId) } },
            ],
        },
        query,
    );

// Explore: approved posts from public accounts, optionally by categories and city.
const exploreFeed = (viewerId, { categories, city, ...query }) =>
    pageOfPosts(
        viewerId,
        {
            status: 'APPROVED',
            author: { status: 'ACTIVE', isPrivate: false, ...notBlockedWith(viewerId), ...notMutedBy(viewerId) },
            ...(categories?.length && { category: { in: categories } }),
            ...(city && { location: { contains: city, mode: 'insensitive' } }),
        },
        query,
    );

// A profile's grid. The owner also sees posts under review or rejected.
const userPosts = async (viewerId, idOrUsername, query) => {
    const user = await findActiveUser(idOrUsername, { viewerId });
    const rel = await relationsFor(viewerId, [user.id]);
    if (!canView(viewerId, user, rel(user.id))) {
        throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');
    }
    return pageOfPosts(viewerId, { authorId: user.id, ...(user.id !== viewerId && { status: 'APPROVED' }) }, query);
};

// Posts with #tag that the viewer may see, newest first.
const hashtagFeed = (viewerId, tag, query) =>
    pageOfPosts(viewerId, { hashtags: { some: { hashtag: { name: tag } } }, ...visibleTo(viewerId) }, query);

// Search: visible posts whose title, description, location, category, hashtags or
// author's name contain `q` (case-insensitive; trigram indexes keep it fast). Newest
// first, so it pages with the same cursor as the feeds.
const searchPosts = (viewerId, q, query) => {
    const like = { contains: q, mode: 'insensitive' };
    return pageOfPosts(
        viewerId,
        {
            AND: [
                visibleTo(viewerId),
                {
                    OR: [
                        { title: like },
                        { description: like },
                        { location: like },
                        { category: like },
                        { author: { name: like } },
                        { hashtags: { some: { hashtag: { name: { contains: q.toLowerCase() } } } } },
                    ],
                },
            ],
        },
        query,
    );
};

// Newest save first. Posts you can no longer see (deleted, author went private) drop out.
const savedPosts = async (viewerId, { cursor, limit }) => {
    const rows = await prisma.postSave.findMany({
        where: { userId: viewerId, post: visibleTo(viewerId), ...afterCursor(cursor, 'postId') },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, postId: true, post: { include: POST_INCLUDE } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'postId');
    return { posts: await toPosts(viewerId, items.map((r) => r.post)), nextCursor };
};

// Reels: single-video posts you can see (public accounts, people you follow, your
// own), newest first. Ranking by watch time/trending can replace the ordering later
// without changing the response.
const reelsFeed = (viewerId, query) =>
    pageOfPosts(viewerId, { AND: [{ isReel: true, author: notMutedBy(viewerId) }, visibleTo(viewerId)] }, query);

// The app calls this when a video has played (and again with the watch time when the
// viewer moves on). First play per viewer = +1 view; later plays only add up plays
// and watch time. The author's own plays are not counted.
const recordView = async (viewerId, postId, { watchMs }) => {
    const post = await findVisiblePost(viewerId, postId);
    const videos = await prisma.postMedia.count({ where: { postId, type: 'VIDEO' } });
    if (videos === 0) throw new AppError('This post has no video', 400, undefined, 'NOT_A_VIDEO');

    if (post.authorId !== viewerId) {
        await prisma.$transaction(async (tx) => {
            const { count } = await tx.postView.createMany({ data: [{ userId: viewerId, postId, watchMs }], skipDuplicates: true });
            if (count) {
                await tx.post.update({ where: { id: postId }, data: { viewsCount: { increment: 1 } }, select: { id: true } });
            } else {
                await tx.postView.update({
                    where: { userId_postId: { userId: viewerId, postId } },
                    data: { plays: { increment: 1 }, watchMs: { increment: watchMs }, lastViewedAt: new Date() },
                });
            }
        });
    }
    const { viewsCount } = await prisma.post.findUnique({ where: { id: postId }, select: { viewsCount: true } });
    return { viewsCount };
};

// ---------- likes, saves, shares ----------

// createMany/deleteMany report whether a row really changed, so double taps and
// races can't move the counter twice (same pattern as follows). `onAdd`/`onRemove`
// run in the same transaction when a row really changed (likes notify the author).
const react = (model, counter, { onAdd, onRemove } = {}) => ({
    add: async (viewerId, postId) => {
        const post = await findVisiblePost(viewerId, postId);
        const [value, notificationId] = await prisma.$transaction(async (tx) => {
            const { count } = await tx[model].createMany({ data: [{ userId: viewerId, postId }], skipDuplicates: true });
            if (!count) return [(await tx.post.findUnique({ where: { id: postId }, select: { [counter]: true } }))[counter]];
            const row = await tx.post.update({ where: { id: postId }, data: { [counter]: { increment: 1 } }, select: { [counter]: true } });
            return [row[counter], await onAdd?.(tx, viewerId, post)];
        });
        notifications.deliver(notificationId);
        return value;
    },
    remove: async (viewerId, postId) => {
        const post = await findVisiblePost(viewerId, postId);
        const [value, changed] = await prisma.$transaction(async (tx) => {
            const { count } = await tx[model].deleteMany({ where: { userId: viewerId, postId } });
            if (!count) return [(await tx.post.findUnique({ where: { id: postId }, select: { [counter]: true } }))[counter]];
            const row = await tx.post.update({ where: { id: postId }, data: { [counter]: { decrement: 1 } }, select: { [counter]: true } });
            return [row[counter], await onRemove?.(tx, viewerId, post)];
        });
        notifications.syncCount(changed);
        return value;
    },
});

const likes = react('postLike', 'likesCount', { onAdd: notifications.postLiked, onRemove: notifications.postUnliked });
const saves = react('postSave', 'savesCount');

const likePost = async (viewerId, postId) => ({ liked: true, likesCount: await likes.add(viewerId, postId) });
const unlikePost = async (viewerId, postId) => ({ liked: false, likesCount: await likes.remove(viewerId, postId) });
const savePost = async (viewerId, postId) => ({ saved: true, savesCount: await saves.add(viewerId, postId) });
const unsavePost = async (viewerId, postId) => ({ saved: false, savesCount: await saves.remove(viewerId, postId) });

// Counts taps on "Share" (the app opens the phone's share sheet). Not de-duplicated,
// like Instagram's send count; the engagement rate limit caps abuse.
const sharePost = async (viewerId, postId) => {
    await findVisiblePost(viewerId, postId);
    const { sharesCount } = await prisma.post.update({
        where: { id: postId },
        data: { sharesCount: { increment: 1 } },
        select: { sharesCount: true },
    });
    return { sharesCount };
};

const listLikes = async (viewerId, postId, { cursor, limit }) => {
    await findVisiblePost(viewerId, postId);
    const rows = await prisma.postLike.findMany({
        where: { postId, user: { status: 'ACTIVE', ...notBlockedWith(viewerId) }, ...afterCursor(cursor, 'userId') },
        orderBy: [{ createdAt: 'desc' }, { userId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, userId: true, user: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'userId');
    const rel = await relationsFor(viewerId, items.map((r) => r.userId));
    return { users: items.map((r) => toCard(r.user, viewerId, rel)), nextCursor };
};

module.exports = {
    POST_INCLUDE,
    toPosts,
    findVisiblePost,
    extractHashtags,
    hashtagFeed,
    searchPosts,
    createPost,
    updatePost,
    deletePost,
    getPost,
    homeFeed,
    exploreFeed,
    userPosts,
    savedPosts,
    reelsFeed,
    recordView,
    likePost,
    unlikePost,
    savePost,
    unsavePost,
    sharePost,
    listLikes,
};
