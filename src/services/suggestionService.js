const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { getSettings } = require('./settingsService');
const { CARD_SELECT, findActiveUser, relationsFor, toCard } = require('./socialGraph');

// "Suggested for you", the people rail on Home (the app's SuggestedVolunteers): active
// volunteers you don't follow or haven't requested, with no block either way, not muted
// or dismissed by you, who allow it (their suggestToOthers) and accept followers (their
// whoCanFollow isn't 'none'). Strongest reason first, as in the app:
//   1. follows you          "Follows you"
//   2. mutual follows       "Followed by Priya + 2 more" (people you follow follow them)
//   3. same city            "Also in Mumbai" (the city on both profiles)
//   4. everyone else        "Suggested for you", most followed first
// Not paginated: the rail shows a handful. Your own showSuggestedVolunteers off = an
// empty list with enabled: false.

const rank = async (viewerId, city, limit) =>
    prisma.$queryRaw`
        WITH my_following AS (SELECT following_id AS id FROM follows WHERE follower_id = ${viewerId}::uuid)
        SELECT u.id,
               EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.following_id = ${viewerId}::uuid) AS "followsYou",
               (SELECT count(*) FROM follows f WHERE f.following_id = u.id AND f.follower_id IN (SELECT id FROM my_following))::int AS mutual,
               -- COALESCE: no profile row = NULL, which DESC would sort first.
               COALESCE(lower(p.city) = lower(${city}::text), false) AS "sameCity"
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
        LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.status = 'ACTIVE'
          AND u.id <> ${viewerId}::uuid
          AND u.id NOT IN (SELECT id FROM my_following)
          AND NOT EXISTS (SELECT 1 FROM follow_requests r WHERE r.requester_id = ${viewerId}::uuid AND r.target_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM blocks b
                          WHERE (b.blocker_id = ${viewerId}::uuid AND b.blocked_id = u.id)
                             OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId}::uuid))
          AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = ${viewerId}::uuid AND m.muted_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM suggestion_dismissals d WHERE d.user_id = ${viewerId}::uuid AND d.dismissed_id = u.id)
          AND COALESCE(s.data->>'suggestToOthers', 'true') <> 'false'
          AND COALESCE(s.data->>'whoCanFollow', 'everyone') <> 'none'
        ORDER BY "followsYou" DESC, mutual DESC, "sameCity" DESC, u.followers_count DESC, u.created_at DESC, u.id
        LIMIT ${limit}`;

const reasonFor = (row, firstMutualName, city) => {
    if (row.followsYou) return { type: 'follows_you', text: 'Follows you', mutualCount: row.mutual };
    if (row.mutual > 0) {
        const more = row.mutual - 1;
        const first = firstMutualName?.split(' ')[0] ?? 'someone you follow';
        return { type: 'mutual', text: more > 0 ? `Followed by ${first} + ${more} more` : `Followed by ${first}`, mutualCount: row.mutual };
    }
    if (row.sameCity) return { type: 'same_city', text: `Also in ${city}`, mutualCount: 0 };
    return { type: 'popular', text: 'Suggested for you', mutualCount: 0 };
};

const listSuggestions = async (viewerId, { limit }) => {
    const [{ showSuggestedVolunteers }, profile] = await Promise.all([
        getSettings(viewerId),
        prisma.profile.findUnique({ where: { userId: viewerId }, select: { city: true } }),
    ]);
    if (!showSuggestedVolunteers) return { enabled: false, users: [] };

    const city = profile?.city ?? null;
    const rows = await rank(viewerId, city, limit);
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { enabled: true, users: [] };

    // The newest mutual connection of each candidate, for "Followed by <name>".
    const [users, mutuals, rel] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: ids } }, select: { ...CARD_SELECT, followersCount: true } }),
        prisma.follow.findMany({
            where: { followingId: { in: ids }, follower: { followers: { some: { followerId: viewerId } }, status: 'ACTIVE' } },
            orderBy: { createdAt: 'desc' },
            select: { followingId: true, follower: { select: { name: true } } },
        }),
        relationsFor(viewerId, ids),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const firstMutual = new Map();
    for (const m of mutuals) if (!firstMutual.has(m.followingId)) firstMutual.set(m.followingId, m.follower.name);

    return {
        enabled: true,
        users: rows
            .filter((r) => byId.has(r.id))
            .map((r) => ({
                ...toCard(byId.get(r.id), viewerId, rel),
                followersCount: byId.get(r.id).followersCount,
                reason: reasonFor(r, firstMutual.get(r.id), city),
            })),
    };
};

// The card's ✕: never suggest this person again. Repeating it is harmless.
const dismiss = async (viewerId, idOrUsername) => {
    const target = await findActiveUser(idOrUsername, { viewerId });
    if (target.id === viewerId) throw new AppError("You can't dismiss yourself", 400, undefined, 'CANNOT_TARGET_SELF');
    await prisma.suggestionDismissal.createMany({ data: [{ userId: viewerId, dismissedId: target.id }], skipDuplicates: true });
    return { dismissed: true };
};

module.exports = { listSuggestions, dismiss };
