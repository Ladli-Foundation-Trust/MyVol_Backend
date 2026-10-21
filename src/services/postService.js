const crypto = require('crypto');
const fs = require('fs/promises');
const prisma = require('../lib/prisma');
const env = require('../config/env');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const { toPostImage } = require('../lib/images');
const { processVideo } = require('../lib/videos');
const { afterCursor, toPage } = require('../utils/cursor');
const { CARD_SELECT, findActiveUser, relationsFor, canView, toCard } = require('./socialGraph');

// ---------- loading & visibility ----------

const POST_INCLUDE = {
    author: { select: { ...CARD_SELECT, status: true } },
    media: {
        orderBy: { position: 'asc' },
        select: { id: true, type: true, key: true, width: true, height: true, thumbnailKey: true, durationMs: true },
    },
};

// Enough to decide whether someone may see or react to a post.
const ACCESS_SELECT = { id: true, authorId: true, status: true, author: { select: { id: true, isPrivate: true, status: true } } };

const postNotFound = () => new AppError('Post not found', 404, undefined, 'POST_NOT_FOUND');

// Who may see a post: its author always (any status). Anyone else only if it is
// APPROVED, the author is active, and the author's profile is visible to them
// (public, or they are an approved follower: socialGraph.canView).
const findVisiblePost = async (viewerId, postId, query = { select: ACCESS_SELECT }) => {
    const post = await prisma.post.findUnique({ where: { id: postId }, ...query });
    if (!post) throw postNotFound();
    if (post.authorId === viewerId) return post;
    if (post.status !== 'APPROVED' || post.author.status !== 'ACTIVE') throw postNotFound();

    const rel = await relationsFor(viewerId, [post.authorId]);
    if (!canView(viewerId, post.author, rel(post.authorId).followStatus)) {
        throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');
    }
    return post;
};

// The same rule as a Prisma `where`, for lists of posts.
const visibleTo = (viewerId) => ({
    author: { status: 'ACTIVE' },
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

        const post = await prisma.post.create({
            data: {
                authorId,
                ...data,
                status: env.POST_AUTO_APPROVE ? 'APPROVED' : 'UNDER_REVIEW',
                isReel: rows.length === 1 && rows[0].type === 'VIDEO',
                media: { create: rows },
            },
            include: POST_INCLUDE,
        });
        return (await toPosts(authorId, [post]))[0];
    } catch (err) {
        await removeFiles(saved);
        throw err;
    }
};

// Text fields only (photos can't be swapped yet). Once moderation is on, an edited
// post goes back to review so approved content can't be changed afterwards.
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

    const updated = await prisma.post.update({
        where: { id: postId },
        data: {
            ...data,
            editedAt: new Date(),
            ...(!env.POST_AUTO_APPROVE && { status: 'UNDER_REVIEW', rejectionReason: null }),
        },
        include: POST_INCLUDE,
    });
    return (await toPosts(viewerId, [updated]))[0];
};

// Likes, saves, comments and media rows go with it (ON DELETE CASCADE); files after.
const deletePost = async (viewerId, postId) => {
    const post = await findOwnPost(viewerId, postId);
    await prisma.post.delete({ where: { id: postId } });
    await removeFiles(mediaKeys(post.media));
};

const getPost = async (viewerId, postId) => {
    const post = await findVisiblePost(viewerId, postId, { include: POST_INCLUDE });
    return (await toPosts(viewerId, [post]))[0];
};

// ---------- feeds (newest first, cursor-paginated) ----------

// Home: your own posts plus approved posts from people you follow.
const homeFeed = (viewerId, query) =>
    pageOfPosts(
        viewerId,
        {
            author: { status: 'ACTIVE' },
            OR: [{ authorId: viewerId }, { status: 'APPROVED', author: { followers: { some: { followerId: viewerId } } } }],
        },
        query,
    );

// Explore: approved posts from public accounts, optionally by categories and city.
const exploreFeed = (viewerId, { categories, city, ...query }) =>
    pageOfPosts(
        viewerId,
        {
            status: 'APPROVED',
            author: { status: 'ACTIVE', isPrivate: false },
            ...(categories?.length && { category: { in: categories } }),
            ...(city && { location: { contains: city, mode: 'insensitive' } }),
        },
        query,
    );

// A profile's grid. The owner also sees posts under review or rejected.
const userPosts = async (viewerId, idOrUsername, query) => {
    const user = await findActiveUser(idOrUsername);
    const rel = await relationsFor(viewerId, [user.id]);
    if (!canView(viewerId, user, rel(user.id).followStatus)) {
        throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');
    }
    return pageOfPosts(viewerId, { authorId: user.id, ...(user.id !== viewerId && { status: 'APPROVED' }) }, query);
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
const reelsFeed = (viewerId, query) => pageOfPosts(viewerId, { isReel: true, ...visibleTo(viewerId) }, query);

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
// races can't move the counter twice (same pattern as follows).
const react = (model, counter) => ({
    add: async (viewerId, postId) => {
        await findVisiblePost(viewerId, postId);
        return prisma.$transaction(async (tx) => {
            const { count } = await tx[model].createMany({ data: [{ userId: viewerId, postId }], skipDuplicates: true });
            const post = count
                ? await tx.post.update({ where: { id: postId }, data: { [counter]: { increment: 1 } }, select: { [counter]: true } })
                : await tx.post.findUnique({ where: { id: postId }, select: { [counter]: true } });
            return post[counter];
        });
    },
    remove: async (viewerId, postId) => {
        await findVisiblePost(viewerId, postId);
        return prisma.$transaction(async (tx) => {
            const { count } = await tx[model].deleteMany({ where: { userId: viewerId, postId } });
            const post = count
                ? await tx.post.update({ where: { id: postId }, data: { [counter]: { decrement: 1 } }, select: { [counter]: true } })
                : await tx.post.findUnique({ where: { id: postId }, select: { [counter]: true } });
            return post[counter];
        });
    },
});

const likes = react('postLike', 'likesCount');
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
        where: { postId, user: { status: 'ACTIVE' }, ...afterCursor(cursor, 'userId') },
        orderBy: [{ createdAt: 'desc' }, { userId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, userId: true, user: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'userId');
    const rel = await relationsFor(viewerId, items.map((r) => r.userId));
    return { users: items.map((r) => toCard(r.user, viewerId, rel)), nextCursor };
};

module.exports = {
    findVisiblePost,
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
