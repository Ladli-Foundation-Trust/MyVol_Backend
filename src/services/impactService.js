const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { MEDAL_TIERS } = require('../config/medals');
const notifications = require('./notificationService');
const { findActiveUser, relationsFor, canView } = require('./socialGraph');

// A volunteer's impact: what their APPROVED activities add up to (posts under review
// or rejected don't count), and the medal ladder on top of it. Computed from posts on
// every read, so it can never drift from the posts themselves; one aggregate over the
// author's posts (index author_id, created_at) is cheap.
//
// Medals follow the current number of approved activities: deleting a post or having
// it rejected can take a medal away again. Reaching a tier sends one `medal`
// notification, once per tier.

const medalsFor = (activities) => {
    const earned = MEDAL_TIERS.filter((t) => activities >= t.activities);
    const next = MEDAL_TIERS.find((t) => activities < t.activities);
    return {
        current: earned.at(-1) ?? null,
        // null once every tier is earned (the app hides its "N away from…" banner).
        next: next ? { ...next, remaining: next.activities - activities } : null,
        tiers: MEDAL_TIERS.map((t) => ({ ...t, earned: activities >= t.activities })),
    };
};

const approvedOf = (userId) => ({ authorId: userId, status: 'APPROVED' });

const totals = async (userId, db = prisma) => {
    const agg = await db.post.aggregate({
        where: approvedOf(userId),
        _count: { _all: true },
        _sum: { hours: true, beneficiaries: true, likesCount: true },
    });
    return {
        activities: agg._count._all,
        hours: agg._sum.hours ?? 0,
        beneficiaries: agg._sum.beneficiaries ?? 0,
        likesReceived: agg._sum.likesCount ?? 0,
    };
};

// The short form embedded in every profile (the header's "Activities" / "Impacted").
const summaryFor = async (userId) => {
    const { activities, hours, beneficiaries } = await totals(userId);
    return { activities, hours, beneficiaries, medal: medalsFor(activities).current?.id ?? null };
};

const byCategory = async (userId) => {
    const rows = await prisma.post.groupBy({
        by: ['category'],
        where: approvedOf(userId),
        _count: { _all: true },
        _sum: { hours: true, beneficiaries: true },
    });
    return rows
        .map((r) => ({ category: r.category, activities: r._count._all, hours: r._sum.hours ?? 0, beneficiaries: r._sum.beneficiaries ?? 0 }))
        .sort((a, b) => b.activities - a.activities || a.category.localeCompare(b.category));
};

// The owner also sees what is still waiting ("2 activities are still in review").
const ownStatusCounts = async (userId) => {
    const rows = await prisma.post.groupBy({ by: ['status'], where: { authorId: userId }, _count: { _all: true } });
    const n = (status) => rows.find((r) => r.status === status)?._count._all ?? 0;
    return { underReview: n('UNDER_REVIEW'), rejected: n('REJECTED') };
};

const getMyImpact = async (userId) => {
    const [sums, categories, own] = await Promise.all([totals(userId), byCategory(userId), ownStatusCounts(userId)]);
    return { impact: { ...sums, ...own, byCategory: categories, medals: medalsFor(sums.activities) } };
};

// Totals and medals are public, like follower counts (a private account's numbers
// show on its profile header too). What the activities were about (byCategory) is
// content, so it needs canView. Nothing across a block.
const getImpact = async (viewerId, idOrUsername) => {
    const user = await findActiveUser(idOrUsername, { viewerId, select: { id: true, isPrivate: true } });
    if (user.id === viewerId) return getMyImpact(viewerId);
    const relation = (await relationsFor(viewerId, [user.id]))(user.id);
    if (relation.blockedByMe) throw new AppError('Unblock this account to see it', 403, undefined, 'USER_BLOCKED');

    const visible = canView(viewerId, user, relation);
    const [sums, categories] = await Promise.all([totals(user.id), visible ? byCategory(user.id) : null]);
    return { impact: { ...sums, byCategory: categories, medals: medalsFor(sums.activities) } };
};

// Call inside the transaction that just APPROVED one of `authorId`'s posts (auto-approve
// on create, or a reviewer). If that approval lands exactly on a tier, records the
// `medal` notification (once per tier: dedupe key medal:<tier>). Returns its id or null.
const checkMedal = async (tx, authorId) => {
    const { activities } = await totals(authorId, tx);
    const tier = MEDAL_TIERS.find((t) => t.activities === activities);
    return tier ? notifications.medalEarned(tx, authorId, tier.id) : null;
};

module.exports = { medalsFor, summaryFor, getMyImpact, getImpact, checkMedal };
