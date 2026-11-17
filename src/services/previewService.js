const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const { findActiveUser } = require('./socialGraph');
const { getSettings } = require('./settingsService');
const ripple = require('./rippleService');

// Link previews for the website (myvol.org/post/…, /user/…, /ripple/…) and the cards
// WhatsApp, Instagram, X and friends build from its Open Graph tags (decision D78).
//
// NO login: these answer what a logged-out stranger may see, which is less than any
// signed-in user sees. Anything private returns exactly what a missing thing returns,
// so a preview never confirms that a private post exists.

const postNotFound = () => new AppError('Post not found', 404, undefined, 'POST_NOT_FOUND');

const snippet = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text ?? null);

const card = (u) => ({ id: u.id, username: u.username, name: u.name, avatarUrl: storage.urlFor(u.avatarKey) });

// Approved posts by active, public accounts that show their activities to everyone:
// the same set Explore shows to anyone (postService.publicActivities without blocks).
const PUBLIC_POST = {
    status: 'APPROVED',
    author: { status: 'ACTIVE', isPrivate: false, activityVisibility: 'everyone' },
};

const getPostPreview = async (postId) => {
    const p = await prisma.post.findFirst({
        where: { id: postId, ...PUBLIC_POST },
        select: {
            id: true,
            title: true,
            description: true,
            category: true,
            location: true,
            beneficiaries: true,
            hours: true,
            likesCount: true,
            commentsCount: true,
            isReel: true,
            createdAt: true,
            author: { select: { id: true, username: true, name: true, avatarKey: true, showLocation: true } },
            media: { orderBy: { position: 'asc' }, take: 1, select: { type: true, key: true, thumbnailKey: true, width: true, height: true } },
        },
    });
    if (!p) throw postNotFound();
    const m = p.media[0];
    return {
        post: {
            id: p.id,
            title: p.title,
            description: snippet(p.description, 300),
            category: p.category,
            // The author's "show location on posts" setting applies here too.
            location: p.author.showLocation ? p.location : null,
            beneficiaries: p.beneficiaries,
            hours: p.hours,
            likesCount: p.likesCount,
            commentsCount: p.commentsCount,
            isVideo: m?.type === 'VIDEO',
            image: m ? { url: storage.urlFor(m.type === 'VIDEO' ? m.thumbnailKey : m.key), width: m.width, height: m.height } : null,
            createdAt: p.createdAt,
        },
        author: card(p.author),
    };
};

const USER_SELECT = {
    id: true,
    username: true,
    name: true,
    avatarKey: true,
    bio: true,
    isPrivate: true,
    activityVisibility: true,
    followersCount: true,
    followingCount: true,
};

// A private account shows its name and photo only, like the app shows it to someone who
// doesn't follow it.
const getUserPreview = async (idOrUsername) => {
    const u = await findActiveUser(idOrUsername, { select: USER_SELECT });
    if (u.isPrivate) return { user: { ...card(u), isPrivate: true } };
    const activitiesPublic = u.activityVisibility === 'everyone';
    const postsCount = activitiesPublic ? await prisma.post.count({ where: { authorId: u.id, status: 'APPROVED' } }) : null;
    return {
        user: {
            ...card(u),
            isPrivate: false,
            bio: snippet(u.bio, 300),
            followersCount: u.followersCount,
            followingCount: u.followingCount,
            postsCount,
        },
    };
};

// Ripple numbers follow the app's rule (rippleService.findRippleOwner): shown unless
// the owner turned "show impact stats" off. Only the totals and badge ids, never the
// tree (that names other people).
const getRipplePreview = async (idOrUsername) => {
    const u = await findActiveUser(idOrUsername, { select: { id: true, username: true, name: true, avatarKey: true } });
    const { showImpactStats } = await getSettings(u.id);
    return { user: card(u), ripple: showImpactStats ? await ripple.summaryFor(u.id) : null };
};

module.exports = { getPostPreview, getUserPreview, getRipplePreview };
