const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const env = require('../config/env');
const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const realtime = require('../lib/realtime');
const AppError = require('../utils/appError');
const sessions = require('./sessionService');
const pushService = require('./pushService');
const { POST_INCLUDE, toPosts } = require('./postService');

// Read models for the admin panel (myvol-admin): dashboards, analytics and the
// browse/search tables. Staff actions that change content still go through
// moderationService so they are logged the same way; the few actions here (sign out
// everywhere, verify email, clear profile) log to moderation_actions too.
//
// Tables page by number (page/pageSize + total), unlike the app's cursors: staff jump
// between pages and want "1–25 of 340".

const TZ = env.DEFAULT_TIMEZONE;
const DAY_MS = 86_400_000;

const notFound = (what) => new AppError(`${what} not found`, 404, undefined, `${what.toUpperCase()}_NOT_FOUND`);
const pageArgs = ({ page, pageSize }) => ({ skip: (page - 1) * pageSize, take: pageSize });
const paged = (items, total, { page, pageSize }) => ({ items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
const ago = (days) => new Date(Date.now() - days * DAY_MS);
const contains = (q) => ({ contains: q, mode: 'insensitive' });

const card = (u) =>
    u ? { id: u.id, username: u.username, name: u.name, avatarUrl: storage.urlFor(u.avatarKey), status: u.status, role: u.role } : null;
const CARD = { id: true, username: true, name: true, avatarKey: true, status: true, role: true };

const thumbOf = (media) => {
    const m = media?.[0];
    if (!m) return null;
    return storage.urlFor(m.type === 'VIDEO' ? m.thumbnailKey : m.key);
};

const log = (moderatorId, action, targetType, targetId, reason, metadata) =>
    prisma.moderationAction.create({ data: { moderatorId, action, targetType, targetId, reason, metadata } });

// ---------- day series ----------

// YYYY-MM-DD in the app's time zone.
const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const lastDays = (days) => {
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) out.push(dayKey(new Date(Date.now() - i * DAY_MS)));
    return [...new Set(out)];
};

const LOCAL_DAY = (col) => `to_char((${col} AT TIME ZONE 'UTC' AT TIME ZONE $1::text)::date, 'YYYY-MM-DD')`;

// Table and column names are constants from this file, never from a request.
const dailyCounts = async (since, table, col = 'created_at', extra = '') => {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT ${LOCAL_DAY(col)} AS d, count(*)::int AS n FROM ${table} WHERE ${col} >= $2::timestamp ${extra} GROUP BY 1`,
        TZ,
        since,
    );
    return new Map(rows.map((r) => [r.d, r.n]));
};

// "Active" = did anything that leaves a trace: opened the app (session used), logged
// in, posted, commented, liked, followed, watched a story or a video.
const dailyActive = async (since) => {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT ${LOCAL_DAY('t')} AS d, count(DISTINCT u)::int AS n FROM (
            SELECT author_id AS u, created_at AS t FROM posts WHERE created_at >= $2::timestamp
            UNION ALL SELECT author_id, created_at FROM comments WHERE created_at >= $2::timestamp
            UNION ALL SELECT user_id, created_at FROM post_likes WHERE created_at >= $2::timestamp
            UNION ALL SELECT follower_id, created_at FROM follows WHERE created_at >= $2::timestamp
            UNION ALL SELECT viewer_id, created_at FROM story_views WHERE created_at >= $2::timestamp
            UNION ALL SELECT user_id, last_viewed_at FROM post_views WHERE last_viewed_at >= $2::timestamp
            UNION ALL SELECT user_id, created_at FROM auth_events WHERE type = 'login' AND user_id IS NOT NULL AND created_at >= $2::timestamp
            UNION ALL SELECT user_id, last_used_at FROM sessions WHERE last_used_at >= $2::timestamp
        ) a GROUP BY 1`,
        TZ,
        since,
    );
    return new Map(rows.map((r) => [r.d, r.n]));
};

const METRICS = {
    signups: (s) => dailyCounts(s, 'users'),
    posts: (s) => dailyCounts(s, 'posts'),
    comments: (s) => dailyCounts(s, 'comments'),
    likes: (s) => dailyCounts(s, 'post_likes'),
    follows: (s) => dailyCounts(s, 'follows'),
    stories: (s) => dailyCounts(s, 'stories'),
    reports: (s) => dailyCounts(s, 'reports'),
    logins: (s) => dailyCounts(s, 'auth_events', 'created_at', "AND type = 'login'"),
    active: (s) => dailyActive(s),
};

const series = async (days, names) => {
    const since = ago(days + 1);
    const maps = await Promise.all(names.map((n) => METRICS[n](since)));
    return lastDays(days).map((date) => Object.fromEntries([['date', date], ...names.map((n, i) => [n, maps[i].get(date) ?? 0])]));
};

const distinctSessionUsers = async (days) => {
    const [row] = await prisma.$queryRaw`SELECT count(DISTINCT user_id)::int AS n FROM sessions WHERE last_used_at >= ${ago(days)}`;
    return row.n;
};

// ---------- shared pieces ----------

const ENGAGEMENT_SQL = '(likes_count + 2 * comments_count + 2 * saves_count + 3 * shares_count + views_count / 10.0)';

const topPosts = async (days, limit = 5) => {
    const ids = await prisma.$queryRawUnsafe(
        `SELECT id::text FROM posts WHERE status = 'APPROVED' AND created_at >= $1::timestamp ORDER BY ${ENGAGEMENT_SQL} DESC, created_at DESC LIMIT ${Number(limit)}`,
        ago(days),
    );
    if (ids.length === 0) return [];
    const rows = await prisma.post.findMany({
        where: { id: { in: ids.map((r) => r.id) } },
        select: {
            id: true,
            title: true,
            category: true,
            createdAt: true,
            likesCount: true,
            commentsCount: true,
            sharesCount: true,
            savesCount: true,
            viewsCount: true,
            isReel: true,
            author: { select: CARD },
            media: { orderBy: { position: 'asc' }, take: 1, select: { type: true, key: true, thumbnailKey: true } },
        },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
        .map((r) => byId.get(r.id))
        .filter(Boolean)
        .map(({ media, author, ...p }) => ({ ...p, author: card(author), thumbnailUrl: thumbOf(media) }));
};

const topCreators = async (days, limit = 5) => {
    const groups = await prisma.post.groupBy({
        by: ['authorId'],
        where: { status: 'APPROVED', createdAt: { gte: ago(days) } },
        _count: { _all: true },
        _sum: { hours: true, beneficiaries: true, likesCount: true },
        orderBy: { _count: { authorId: 'desc' } },
        take: limit,
    });
    const users = await prisma.user.findMany({ where: { id: { in: groups.map((g) => g.authorId) } }, select: { ...CARD, followersCount: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return groups.map((g) => ({
        user: { ...card(byId.get(g.authorId)), followersCount: byId.get(g.authorId)?.followersCount ?? 0 },
        posts: g._count._all,
        hours: g._sum.hours ?? 0,
        beneficiaries: g._sum.beneficiaries ?? 0,
        likes: g._sum.likesCount ?? 0,
    }));
};

const countBy = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r._count._all]));

// Things waiting for a person. Also feeds the sidebar badges.
const queues = async () => {
    const [pendingPosts, openReports, rippleQueue, openProblems] = await Promise.all([
        prisma.post.count({ where: { status: 'UNDER_REVIEW', author: { status: { not: 'PENDING_DELETION' } } } }),
        prisma.report.count({ where: { status: 'OPEN', type: { not: 'PROBLEM' } } }),
        prisma.post.count({ where: { rippleStatus: 'PENDING', rippleReviewRequestedAt: { not: null } } }),
        prisma.report.count({ where: { status: 'OPEN', type: 'PROBLEM' } }),
    ]);
    // autoApprove: new posts skip the queue (they only land in it when reports hide them).
    return { pendingPosts, openReports, rippleQueue, openProblems, autoApprove: env.POST_AUTO_APPROVE, reportHideThreshold: env.REPORT_AUTO_HIDE_THRESHOLD };
};

// ---------- overview ----------

const overview = async () => {
    const [
        usersByStatus,
        usersByRole,
        newToday,
        new7,
        new30,
        dau,
        wau,
        mau,
        postsByStatus,
        reels,
        comments,
        likes,
        follows,
        liveStories,
        impact,
        categories,
        waiting,
        daily,
        posts30,
        creators30,
        newestUsers,
        latestReports,
        recentActions,
    ] = await Promise.all([
        prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
        prisma.user.count({ where: { createdAt: { gte: ago(1) } } }),
        prisma.user.count({ where: { createdAt: { gte: ago(7) } } }),
        prisma.user.count({ where: { createdAt: { gte: ago(30) } } }),
        distinctSessionUsers(1),
        distinctSessionUsers(7),
        distinctSessionUsers(30),
        prisma.post.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.post.count({ where: { isReel: true, status: 'APPROVED' } }),
        prisma.comment.count(),
        prisma.postLike.count(),
        prisma.follow.count(),
        prisma.story.count({ where: { expiresAt: { gt: new Date() } } }),
        prisma.post.aggregate({ where: { status: 'APPROVED' }, _sum: { hours: true, beneficiaries: true } }),
        prisma.post.groupBy({ by: ['category'], where: { status: 'APPROVED' }, _count: { _all: true }, orderBy: { _count: { category: 'desc' } } }),
        queues(),
        series(30, ['signups', 'active', 'posts', 'comments', 'likes']),
        topPosts(30),
        topCreators(30),
        prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { ...CARD, createdAt: true } }),
        prisma.report.findMany({
            where: { status: 'OPEN' },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { id: true, type: true, reason: true, category: true, details: true, createdAt: true, reporter: { select: CARD }, user: { select: CARD } },
        }),
        prisma.moderationAction.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: { moderator: { select: CARD } } }),
    ]);

    const status = countBy(usersByStatus, 'status');
    const postStatus = countBy(postsByStatus, 'status');
    return {
        users: {
            total: usersByStatus.reduce((n, r) => n + r._count._all, 0),
            byStatus: status,
            byRole: countBy(usersByRole, 'role'),
            newToday,
            new7d: new7,
            new30d: new30,
        },
        activeUsers: { day: dau, week: wau, month: mau },
        online: realtime.onlineStats(),
        posts: {
            total: postsByStatus.reduce((n, r) => n + r._count._all, 0),
            byStatus: postStatus,
            reels,
        },
        engagement: { comments, likes, follows, liveStories },
        impact: { hours: impact._sum.hours ?? 0, beneficiaries: impact._sum.beneficiaries ?? 0, activities: postStatus.APPROVED ?? 0 },
        categories: categories.map((c) => ({ category: c.category, count: c._count._all })),
        queues: waiting,
        daily,
        topPosts: posts30,
        topCreators: creators30,
        newestUsers: newestUsers.map((u) => ({ ...card(u), createdAt: u.createdAt })),
        latestReports: latestReports.map((r) => ({
            id: r.id,
            type: r.type.toLowerCase(),
            reason: r.reason?.toLowerCase() ?? r.category,
            details: r.details,
            createdAt: r.createdAt,
            reporter: card(r.reporter),
            user: card(r.user),
        })),
        recentActions: recentActions.map((a) => ({ ...a, moderator: card(a.moderator) })),
    };
};

// ---------- analytics ----------

const pct = (now, before) => (before === 0 ? (now === 0 ? 0 : null) : Math.round(((now - before) / before) * 1000) / 10);

const AGE_SQL = `
    SELECT CASE
        WHEN date_of_birth IS NULL THEN 'Unknown'
        WHEN age(date_of_birth) < interval '18 years' THEN '13–17'
        WHEN age(date_of_birth) < interval '25 years' THEN '18–24'
        WHEN age(date_of_birth) < interval '35 years' THEN '25–34'
        WHEN age(date_of_birth) < interval '45 years' THEN '35–44'
        WHEN age(date_of_birth) < interval '60 years' THEN '45–59'
        ELSE '60+' END AS label, count(*)::int AS n
    FROM users WHERE status <> 'PENDING_DELETION' GROUP BY 1`;

const AGE_ORDER = ['13–17', '18–24', '25–34', '35–44', '45–59', '60+', 'Unknown'];

const unnestTop = (column, limit = 10) =>
    prisma.$queryRawUnsafe(`SELECT v AS label, count(*)::int AS n FROM profiles, unnest(${column}) AS v GROUP BY 1 ORDER BY 2 DESC LIMIT ${Number(limit)}`);

// Weekly sign-up groups: how many of each are still around (used the app in the last
// 7 days). Simple, and enough to see whether new people stay.
const cohorts = async (weeks = 8) => {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT to_char(date_trunc('week', u.created_at AT TIME ZONE 'UTC' AT TIME ZONE $1::text), 'YYYY-MM-DD') AS week,
                count(*)::int AS joined,
                count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.last_used_at >= now() AT TIME ZONE 'UTC' - interval '7 days'
                ))::int AS active,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id))::int AS posted
         FROM users u
         WHERE u.created_at >= $2::timestamp
         GROUP BY 1 ORDER BY 1`,
        TZ,
        ago(weeks * 7),
    );
    return rows.map((r) => ({ ...r, activeRate: r.joined ? Math.round((r.active / r.joined) * 100) : 0, postedRate: r.joined ? Math.round((r.posted / r.joined) * 100) : 0 }));
};

const analytics = async ({ days }) => {
    const now = new Date();
    const from = ago(days);
    const prevFrom = ago(days * 2);
    const inRange = { createdAt: { gte: from } };
    const inPrev = { createdAt: { gte: prevFrom, lt: from } };

    const totalsFor = (where) =>
        Promise.all([
            prisma.user.count({ where }),
            prisma.post.count({ where }),
            prisma.comment.count({ where }),
            prisma.postLike.count({ where }),
            prisma.follow.count({ where }),
            prisma.story.count({ where }),
            prisma.report.count({ where }),
            prisma.post.aggregate({ where: { ...where, status: 'APPROVED' }, _sum: { hours: true, beneficiaries: true } }),
        ]);

    const [
        daily,
        cur,
        prev,
        gender,
        ages,
        cities,
        states,
        areas,
        skills,
        signupGoogle,
        signupPhoneOnly,
        verified,
        privateAccounts,
        allUsers,
        platforms,
        catImpact,
        mediaMix,
        hashtags,
        reportReasons,
        reportTypes,
        resolveTime,
        byModerator,
        cohortRows,
        creators,
        posts,
    ] = await Promise.all([
        series(days, ['signups', 'active', 'posts', 'comments', 'likes', 'follows', 'stories', 'reports', 'logins']),
        totalsFor(inRange),
        totalsFor(inPrev),
        prisma.profile.groupBy({ by: ['gender'], _count: { _all: true } }),
        prisma.$queryRawUnsafe(AGE_SQL),
        prisma.$queryRawUnsafe(`SELECT initcap(trim(city)) AS label, count(*)::int AS n FROM profiles WHERE coalesce(trim(city), '') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
        prisma.$queryRawUnsafe(`SELECT initcap(trim(state)) AS label, count(*)::int AS n FROM profiles WHERE coalesce(trim(state), '') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
        unnestTop('preferred_areas'),
        unnestTop('skills'),
        prisma.user.count({ where: { oauthAccounts: { some: {} } } }),
        prisma.user.count({ where: { email: null } }),
        prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
        prisma.user.count({ where: { isPrivate: true } }),
        prisma.user.count(),
        prisma.$queryRaw`SELECT pt.platform AS label, count(DISTINCT pt.user_id)::int AS n FROM push_tokens pt JOIN sessions s ON s.id = pt.session_id WHERE s.revoked_at IS NULL GROUP BY 1`,
        prisma.post.groupBy({
            by: ['category'],
            where: { status: 'APPROVED', ...inRange },
            _count: { _all: true },
            _sum: { hours: true, beneficiaries: true },
            orderBy: { _count: { category: 'desc' } },
        }),
        prisma.$queryRaw`
            SELECT CASE WHEN p.is_reel THEN 'Reels'
                        WHEN EXISTS (SELECT 1 FROM post_media m WHERE m.post_id = p.id AND m.type = 'VIDEO') THEN 'Videos'
                        WHEN EXISTS (SELECT 1 FROM post_media m WHERE m.post_id = p.id) THEN 'Photos'
                        ELSE 'Text only' END AS label, count(*)::int AS n
            FROM posts p WHERE p.created_at >= ${from} GROUP BY 1`,
        prisma.hashtag.findMany({ where: { postsCount: { gt: 0 } }, orderBy: { postsCount: 'desc' }, take: 10, select: { name: true, postsCount: true } }),
        prisma.report.groupBy({ by: ['reason'], where: { ...inRange, type: { not: 'PROBLEM' } }, _count: { _all: true } }),
        prisma.report.groupBy({ by: ['type'], where: inRange, _count: { _all: true } }),
        prisma.$queryRaw`SELECT coalesce(avg(extract(epoch FROM resolved_at - created_at)) / 3600, 0)::float8 AS hours, count(*)::int AS n FROM reports WHERE resolved_at IS NOT NULL AND created_at >= ${from}`,
        prisma.moderationAction.groupBy({ by: ['moderatorId'], where: inRange, _count: { _all: true }, orderBy: { _count: { moderatorId: 'desc' } }, take: 10 }),
        cohorts(),
        topCreators(days, 10),
        topPosts(days, 10),
    ]);

    const names = ['signups', 'posts', 'comments', 'likes', 'follows', 'stories', 'reports'];
    const totals = Object.fromEntries(names.map((n, i) => [n, { value: cur[i], previous: prev[i], change: pct(cur[i], prev[i]) }]));
    totals.hours = { value: cur[7]._sum.hours ?? 0, previous: prev[7]._sum.hours ?? 0, change: pct(cur[7]._sum.hours ?? 0, prev[7]._sum.hours ?? 0) };
    totals.beneficiaries = {
        value: cur[7]._sum.beneficiaries ?? 0,
        previous: prev[7]._sum.beneficiaries ?? 0,
        change: pct(cur[7]._sum.beneficiaries ?? 0, prev[7]._sum.beneficiaries ?? 0),
    };
    const avgActive = Math.round(daily.reduce((n, d) => n + d.active, 0) / Math.max(1, daily.length));

    const mods = await prisma.user.findMany({ where: { id: { in: byModerator.map((m) => m.moderatorId).filter(Boolean) } }, select: CARD });
    const modById = new Map(mods.map((m) => [m.id, m]));

    return {
        range: { days, from, to: now },
        totals,
        avgDailyActive: avgActive,
        daily,
        audience: {
            gender: gender.map((g) => ({ label: g.gender || 'Not set', n: g._count._all })),
            age: ages.sort((a, b) => AGE_ORDER.indexOf(a.label) - AGE_ORDER.indexOf(b.label)),
            cities,
            states,
            causes: areas,
            skills,
            signupMethod: [
                { label: 'Google', n: signupGoogle },
                { label: 'Phone only', n: signupPhoneOnly },
                { label: 'Email', n: Math.max(0, allUsers - signupGoogle - signupPhoneOnly) },
            ],
            emailVerified: { verified, total: allUsers },
            privateAccounts: { count: privateAccounts, total: allUsers },
            platforms,
        },
        content: {
            categories: catImpact.map((c) => ({ category: c.category, posts: c._count._all, hours: c._sum.hours ?? 0, beneficiaries: c._sum.beneficiaries ?? 0 })),
            mediaMix,
            hashtags,
            topPosts: posts,
            topCreators: creators,
            perPost: {
                likes: cur[1] ? Math.round((cur[3] / cur[1]) * 10) / 10 : 0,
                comments: cur[1] ? Math.round((cur[2] / cur[1]) * 10) / 10 : 0,
            },
        },
        retention: cohortRows,
        moderation: {
            reasons: reportReasons.map((r) => ({ label: (r.reason ?? 'OTHER').toLowerCase(), n: r._count._all })),
            types: reportTypes.map((r) => ({ label: r.type.toLowerCase(), n: r._count._all })),
            avgResolveHours: Math.round(resolveTime[0].hours * 10) / 10,
            resolved: resolveTime[0].n,
            byModerator: byModerator.map((m) => ({ moderator: m.moderatorId ? card(modById.get(m.moderatorId)) : null, n: m._count._all })),
        },
    };
};

// ---------- users ----------

const USER_SORT = {
    newest: [{ createdAt: 'desc' }],
    oldest: [{ createdAt: 'asc' }],
    followers: [{ followersCount: 'desc' }, { createdAt: 'desc' }],
    lastLogin: [{ lastLoginAt: { sort: 'desc', nulls: 'last' } }],
    name: [{ name: 'asc' }],
};

const listUsers = async ({ q, status, role, verified, sort, ...page }) => {
    const where = {
        AND: [
            q ? { OR: [{ username: contains(q) }, { name: contains(q) }, { email: contains(q) }, { phone: { contains: q } }] } : {},
            status ? { status } : {},
            role ? { role } : {},
            verified === true ? { emailVerifiedAt: { not: null } } : verified === false ? { emailVerifiedAt: null, email: { not: null } } : {},
        ],
    };
    const [total, rows] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
            where,
            orderBy: USER_SORT[sort],
            ...pageArgs(page),
            select: {
                ...CARD,
                email: true,
                phone: true,
                emailVerifiedAt: true,
                isPrivate: true,
                followersCount: true,
                followingCount: true,
                lastLoginAt: true,
                createdAt: true,
                profile: { select: { city: true } },
                _count: { select: { posts: true, comments: true } },
            },
        }),
    ]);
    const reports = await prisma.report.groupBy({ by: ['userId'], where: { userId: { in: rows.map((r) => r.id) }, status: 'OPEN' }, _count: { _all: true } });
    const reportsOf = new Map(reports.map((r) => [r.userId, r._count._all]));
    return paged(
        rows.map((u) => ({
            ...card(u),
            email: u.email,
            phone: u.phone,
            emailVerified: Boolean(u.emailVerifiedAt),
            isPrivate: u.isPrivate,
            followersCount: u.followersCount,
            followingCount: u.followingCount,
            postsCount: u._count.posts,
            commentsCount: u._count.comments,
            city: u.profile?.city ?? null,
            openReports: reportsOf.get(u.id) ?? 0,
            lastLoginAt: u.lastLoginAt,
            createdAt: u.createdAt,
        })),
        total,
        page,
    );
};

const getUser = async (userId) => {
    const u = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            profile: true,
            oauthAccounts: { select: { provider: true, email: true, createdAt: true } },
            badges: { orderBy: { earnedAt: 'desc' } },
            _count: {
                select: {
                    posts: true,
                    comments: true,
                    postLikes: true,
                    stories: true,
                    reportsMade: true,
                    reportsReceived: true,
                    blocksReceived: true,
                    mutesReceived: true,
                    pledges: true,
                },
            },
        },
    });
    if (!u) throw notFound('User');

    const [live, events, actions, reports, posts, impact, lastActive] = await Promise.all([
        prisma.session.findMany({
            where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { lastUsedAt: 'desc' },
            select: { id: true, deviceName: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true, pushToken: { select: { platform: true } } },
        }),
        prisma.authEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 25 }),
        prisma.moderationAction.findMany({ where: { targetId: userId }, orderBy: { createdAt: 'desc' }, take: 20, include: { moderator: { select: CARD } } }),
        prisma.report.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 15,
            select: { id: true, type: true, reason: true, details: true, status: true, resolution: true, createdAt: true, reporter: { select: CARD } },
        }),
        prisma.post.findMany({
            where: { authorId: userId },
            orderBy: { createdAt: 'desc' },
            take: 12,
            select: {
                id: true,
                title: true,
                status: true,
                category: true,
                createdAt: true,
                likesCount: true,
                commentsCount: true,
                isReel: true,
                media: { orderBy: { position: 'asc' }, take: 1, select: { type: true, key: true, thumbnailKey: true } },
            },
        }),
        prisma.post.aggregate({ where: { authorId: userId, status: 'APPROVED' }, _sum: { hours: true, beneficiaries: true } }),
        prisma.session.findFirst({ where: { userId }, orderBy: { lastUsedAt: 'desc' }, select: { lastUsedAt: true } }),
    ]);

    return {
        user: {
            ...card(u),
            email: u.email,
            phone: u.phone,
            bio: u.bio,
            emailVerified: Boolean(u.emailVerifiedAt),
            emailVerifiedAt: u.emailVerifiedAt,
            dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().slice(0, 10) : null,
            isPrivate: u.isPrivate,
            activityVisibility: u.activityVisibility,
            followersCount: u.followersCount,
            followingCount: u.followingCount,
            failedLoginCount: u.failedLoginCount,
            lockedUntil: u.lockedUntil,
            lastLoginAt: u.lastLoginAt,
            lastActiveAt: lastActive?.lastUsedAt ?? null,
            termsAcceptedAt: u.termsAcceptedAt,
            deactivatedAt: u.deactivatedAt,
            deletionScheduledAt: u.deletionScheduledAt,
            createdAt: u.createdAt,
            hasGoogle: u.oauthAccounts.length > 0,
            online: realtime.connectedDevices(userId),
        },
        profile: u.profile,
        counts: u._count,
        impact: { hours: impact._sum.hours ?? 0, beneficiaries: impact._sum.beneficiaries ?? 0 },
        badges: u.badges,
        sessions: live.map((s) => ({ ...s, platform: s.pushToken?.platform ?? null, pushToken: undefined })),
        authEvents: events,
        actions: actions.map((a) => ({ ...a, moderator: card(a.moderator) })),
        reports: reports.map((r) => ({ ...r, type: r.type.toLowerCase(), reason: r.reason?.toLowerCase() ?? null, reporter: card(r.reporter) })),
        posts: posts.map(({ media, ...p }) => ({ ...p, thumbnailUrl: thumbOf(media) })),
    };
};

const findUser = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerifiedAt: true, avatarKey: true, bio: true } });
    if (!user) throw notFound('User');
    return user;
};

// Sign the person out of every device (a stolen phone, a support request).
const logoutEverywhere = async (adminId, userId, { reason }) => {
    await findUser(userId);
    const { count } = await sessions.revokeAllSessions(userId, 'admin');
    realtime.disconnectUser(userId, 'SESSION_REVOKED');
    await log(adminId, 'FORCE_LOGOUT', 'user', userId, reason, { sessions: count });
    return { user: { id: userId }, sessionsEnded: count };
};

// Support tool: someone who can't receive the email code.
const verifyEmail = async (adminId, userId, { reason }) => {
    const user = await findUser(userId);
    if (!user.email) throw new AppError('This account has no email address', 409, undefined, 'NO_EMAIL');
    if (user.emailVerifiedAt) throw new AppError('This email is already verified', 409, undefined, 'ALREADY_VERIFIED');
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() }, select: { id: true } });
    await log(adminId, 'VERIFY_EMAIL', 'user', userId, reason);
    return { user: { id: userId, emailVerified: true } };
};

// Removes an offensive profile photo and/or bio without suspending the account.
const clearProfile = async (adminId, userId, { avatar, bio, reason }) => {
    const user = await findUser(userId);
    if (!avatar && !bio) throw new AppError('Choose the photo, the bio or both', 400, undefined, 'NOTHING_TO_CLEAR');
    await prisma.user.update({
        where: { id: userId },
        data: { ...(avatar && { avatarKey: null }), ...(bio && { bio: null }) },
        select: { id: true },
    });
    if (avatar && user.avatarKey) await storage.remove(user.avatarKey).catch(() => {});
    await log(adminId, 'CLEAR_PROFILE', 'user', userId, reason, { avatar: Boolean(avatar), bio: bio ? user.bio : undefined });
    return { user: { id: userId, avatarCleared: Boolean(avatar), bioCleared: Boolean(bio) } };
};

// ---------- posts ----------

const POST_SORT = {
    newest: [{ createdAt: 'desc' }],
    oldest: [{ createdAt: 'asc' }],
    likes: [{ likesCount: 'desc' }, { createdAt: 'desc' }],
    comments: [{ commentsCount: 'desc' }, { createdAt: 'desc' }],
    views: [{ viewsCount: 'desc' }, { createdAt: 'desc' }],
};

const MEDIA_FILTER = {
    reel: { isReel: true },
    video: { media: { some: { type: 'VIDEO' } } },
    photo: { isReel: false, media: { some: { type: 'IMAGE' } } },
    text: { media: { none: {} } },
};

const listPosts = async ({ q, status, category, media, featured, authorId, sort, ...page }) => {
    const where = {
        AND: [
            q ? { OR: [{ title: contains(q) }, { description: contains(q) }, { location: contains(q) }, { author: { username: contains(q) } }] } : {},
            status ? { status } : {},
            category ? { category } : {},
            media ? MEDIA_FILTER[media] : {},
            featured ? { featuredAt: { not: null } } : {},
            authorId ? { authorId } : {},
        ],
    };
    const [total, rows, cats] = await Promise.all([
        prisma.post.count({ where }),
        prisma.post.findMany({
            where,
            orderBy: POST_SORT[sort],
            ...pageArgs(page),
            select: {
                id: true,
                title: true,
                category: true,
                status: true,
                location: true,
                isReel: true,
                featuredAt: true,
                hours: true,
                beneficiaries: true,
                likesCount: true,
                commentsCount: true,
                savesCount: true,
                sharesCount: true,
                viewsCount: true,
                rippleStatus: true,
                createdAt: true,
                author: { select: CARD },
                media: { orderBy: { position: 'asc' }, select: { type: true, key: true, thumbnailKey: true } },
            },
        }),
        prisma.post.groupBy({ by: ['category'], _count: { _all: true }, orderBy: { category: 'asc' } }),
    ]);
    const reports = await prisma.report.groupBy({ by: ['postId'], where: { postId: { in: rows.map((r) => r.id) }, status: 'OPEN' }, _count: { _all: true } });
    const reportsOf = new Map(reports.map((r) => [r.postId, r._count._all]));
    return {
        ...paged(
            rows.map(({ media, author, ...p }) => ({
                ...p,
                featured: Boolean(p.featuredAt),
                author: card(author),
                thumbnailUrl: thumbOf(media),
                mediaCount: media.length,
                hasVideo: media.some((m) => m.type === 'VIDEO'),
                openReports: reportsOf.get(p.id) ?? 0,
            })),
            total,
            page,
        ),
        categories: cats.map((c) => c.category),
    };
};

const getPost = async (adminId, postId) => {
    const post = await prisma.post.findUnique({ where: { id: postId }, include: POST_INCLUDE });
    if (!post) throw notFound('Post');
    const [[shaped], reports, actions, comments, inspiredBy, likers] = await Promise.all([
        toPosts(adminId, [post]),
        prisma.report.findMany({
            where: { postId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { id: true, reason: true, details: true, status: true, resolution: true, createdAt: true, reporter: { select: CARD } },
        }),
        prisma.moderationAction.findMany({ where: { targetId: postId }, orderBy: { createdAt: 'desc' }, take: 20, include: { moderator: { select: CARD } } }),
        prisma.comment.findMany({
            where: { postId },
            orderBy: { createdAt: 'desc' },
            take: 30,
            select: { id: true, text: true, isOffensive: true, likesCount: true, parentId: true, createdAt: true, author: { select: CARD } },
        }),
        post.inspiredById ? prisma.post.findUnique({ where: { id: post.inspiredById }, select: { id: true, title: true, author: { select: CARD } } }) : null,
        prisma.postLike.findMany({ where: { postId }, orderBy: { createdAt: 'desc' }, take: 12, select: { createdAt: true, user: { select: CARD } } }),
    ]);
    return {
        post: {
            ...shaped,
            // toPosts hides some fields from non-authors; staff see everything.
            location: post.location,
            likesCount: post.likesCount,
            status: post.status,
            rejectionReason: post.rejectionReason,
            featuredAt: post.featuredAt,
            rippleStatus: post.rippleStatus,
            rippleRejectionReason: post.rippleRejectionReason,
            author: card(post.author),
            inspiredByPost: inspiredBy ? { ...inspiredBy, author: card(inspiredBy.author) } : null,
        },
        reports: reports.map((r) => ({ ...r, reason: r.reason?.toLowerCase() ?? null, reporter: card(r.reporter) })),
        actions: actions.map((a) => ({ ...a, moderator: card(a.moderator) })),
        comments: comments.map((c) => ({ ...c, author: card(c.author) })),
        likers: likers.map((l) => ({ ...card(l.user), likedAt: l.createdAt })),
    };
};

// ---------- comments ----------

const listComments = async ({ q, offensive, postId, authorId, ...page }) => {
    const where = {
        AND: [
            q ? { OR: [{ text: contains(q) }, { author: { username: contains(q) } }] } : {},
            offensive ? { isOffensive: true } : {},
            postId ? { postId } : {},
            authorId ? { authorId } : {},
        ],
    };
    const [total, rows] = await Promise.all([
        prisma.comment.count({ where }),
        prisma.comment.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...pageArgs(page),
            select: {
                id: true,
                text: true,
                isOffensive: true,
                likesCount: true,
                repliesCount: true,
                parentId: true,
                createdAt: true,
                author: { select: CARD },
                post: { select: { id: true, title: true } },
            },
        }),
    ]);
    const reports = await prisma.report.groupBy({ by: ['commentId'], where: { commentId: { in: rows.map((r) => r.id) }, status: 'OPEN' }, _count: { _all: true } });
    const reportsOf = new Map(reports.map((r) => [r.commentId, r._count._all]));
    return paged(
        rows.map((c) => ({ ...c, isReply: Boolean(c.parentId), author: card(c.author), openReports: reportsOf.get(c.id) ?? 0 })),
        total,
        page,
    );
};

// ---------- stories ----------

const listStories = async ({ q, ...page }) => {
    const where = { expiresAt: { gt: new Date() }, ...(q && { OR: [{ caption: contains(q) }, { author: { username: contains(q) } }] }) };
    const [total, rows] = await Promise.all([
        prisma.story.count({ where }),
        prisma.story.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(page), include: { author: { select: CARD } } }),
    ]);
    const reports = await prisma.report.groupBy({ by: ['storyId'], where: { storyId: { in: rows.map((r) => r.id) }, status: 'OPEN' }, _count: { _all: true } });
    const reportsOf = new Map(reports.map((r) => [r.storyId, r._count._all]));
    return paged(
        rows.map((s) => ({
            id: s.id,
            type: s.type.toLowerCase(),
            url: storage.urlFor(s.key),
            thumbnailUrl: storage.urlFor(s.thumbnailKey ?? s.key),
            caption: s.caption,
            viewsCount: s.viewsCount,
            likesCount: s.likesCount,
            durationMs: s.durationMs,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            author: card(s.author),
            openReports: reportsOf.get(s.id) ?? 0,
        })),
        total,
        page,
    );
};

// ---------- hashtags ----------

const listHashtags = async ({ q, ...page }) => {
    const where = q ? { name: contains(q.replace(/^#/, '')) } : {};
    const [total, rows] = await Promise.all([
        prisma.hashtag.count({ where }),
        prisma.hashtag.findMany({ where, orderBy: [{ postsCount: 'desc' }, { name: 'asc' }], ...pageArgs(page) }),
    ]);
    return paged(rows, total, page);
};

// ---------- security log (ADMIN) ----------

const listAuthEvents = async ({ type, q, ...page }) => {
    const where = {
        ...(type && { type }),
        ...(q && { OR: [{ ip: { contains: q } }, { user: { username: contains(q) } }, { user: { email: contains(q) } }] }),
    };
    const [total, rows, last24, failedIps, locked] = await Promise.all([
        prisma.authEvent.count({ where }),
        prisma.authEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(page), include: { user: { select: CARD } } }),
        prisma.authEvent.groupBy({ by: ['type'], where: { createdAt: { gte: ago(1) } }, _count: { _all: true } }),
        prisma.$queryRaw`SELECT ip, count(*)::int AS n FROM auth_events WHERE type = 'login_failed' AND created_at >= ${ago(1)} AND ip IS NOT NULL GROUP BY ip ORDER BY n DESC LIMIT 8`,
        prisma.user.findMany({ where: { lockedUntil: { gt: new Date() } }, select: { ...CARD, lockedUntil: true, failedLoginCount: true }, take: 20 }),
    ]);
    return {
        ...paged(
            rows.map((e) => ({ ...e, user: card(e.user) })),
            total,
            page,
        ),
        last24h: countBy(last24, 'type'),
        failedIps,
        locked: locked.map((u) => ({ ...card(u), lockedUntil: u.lockedUntil, failedLoginCount: u.failedLoginCount })),
    };
};

// ---------- system (ADMIN) ----------

// Sizes of the top-level upload folders (avatars, posts, stories…). Stops counting
// after MAX_FILES so a huge disk can't stall the request.
const MAX_FILES = 50_000;
const folderSizes = async () => {
    const out = {};
    let files = 0;
    let truncated = false;
    const walk = async (dir, bucket) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (files >= MAX_FILES) {
                truncated = true;
                return;
            }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full, bucket ?? e.name);
            else if (e.isFile()) {
                files += 1;
                const { size } = await fs.stat(full).catch(() => ({ size: 0 }));
                const key = bucket ?? '(root)';
                out[key] = out[key] ?? { bytes: 0, files: 0 };
                out[key].bytes += size;
                out[key].files += 1;
            }
        }
    };
    await walk(storage.ROOT, null);
    return { folders: out, totalBytes: Object.values(out).reduce((n, f) => n + f.bytes, 0), files, truncated };
};

const system = async () => {
    const started = Date.now();
    const [[db], tables, uploads, migrations] = await Promise.all([
        prisma.$queryRaw`SELECT pg_database_size(current_database())::float8 AS bytes, version() AS version, current_database() AS name,
                                (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`,
        prisma.$queryRaw`SELECT relname AS name, n_live_tup::float8 AS rows, pg_total_relation_size(relid)::float8 AS bytes
                         FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`,
        folderSizes(),
        prisma.$queryRaw`SELECT migration_name AS name, finished_at AS "finishedAt" FROM _prisma_migrations ORDER BY finished_at DESC NULLS FIRST LIMIT 5`.catch(() => []),
    ]);
    const dbLatencyMs = Date.now() - started;
    const mem = process.memoryUsage();
    return {
        server: {
            status: 'ok',
            nodeEnv: env.NODE_ENV,
            node: process.version,
            platform: `${os.type()} ${os.release()} (${os.arch()})`,
            uptimeSeconds: Math.round(process.uptime()),
            hostUptimeSeconds: Math.round(os.uptime()),
            cpus: os.cpus().length,
            loadAvg: os.loadavg(),
            memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, systemFree: os.freemem(), systemTotal: os.totalmem() },
            time: new Date(),
            timezone: TZ,
            publicBaseUrl: env.publicBaseUrl,
        },
        realtime: realtime.onlineStats(),
        database: { ...db, latencyMs: dbLatencyMs, tables, migrations },
        storage: { driver: 'local disk', root: storage.ROOT, ...uploads },
        services: [
            { key: 'email', label: 'Email (verification codes)', ok: env.sesConfigured || Boolean(env.SMTP_URL), detail: env.sesConfigured ? 'AWS SES' : env.SMTP_URL ? 'SMTP' : 'Not set: codes print to the server console' },
            { key: 'sms', label: 'SMS (phone login codes)', ok: false, detail: 'No provider yet: codes print to the server console' },
            { key: 'push', label: 'Push notifications (Firebase)', ok: pushService.isEnabled(), detail: pushService.isEnabled() ? 'Firebase Cloud Messaging' : 'Not set: only in-app (WebSocket) delivery' },
            { key: 'google', label: 'Google sign-in', ok: env.googleWebOAuth, detail: env.googleWebOAuth ? env.googleRedirectUri : 'Not set' },
            { key: 'storage', label: 'File storage', ok: true, warn: true, detail: 'Server disk (move to S3/R2 + CDN before launch)' },
        ],
        config: [
            { key: 'POST_AUTO_APPROVE', label: 'New posts go live without review', value: env.POST_AUTO_APPROVE },
            { key: 'REPORT_AUTO_HIDE_THRESHOLD', label: 'Reports that hide a post automatically', value: env.REPORT_AUTO_HIDE_THRESHOLD },
            { key: 'MIN_SIGNUP_AGE', label: 'Minimum age to sign up', value: env.MIN_SIGNUP_AGE },
            { key: 'MAX_SESSIONS_PER_USER', label: 'Devices logged in per person', value: env.MAX_SESSIONS_PER_USER },
            { key: 'MAX_ACCOUNTS_PER_PHONE', label: 'Accounts per phone number', value: env.MAX_ACCOUNTS_PER_PHONE },
            { key: 'MAX_POST_IMAGE_MB', label: 'Largest photo (MB)', value: env.MAX_POST_IMAGE_MB },
            { key: 'MAX_POST_VIDEO_MB', label: 'Largest video (MB)', value: env.MAX_POST_VIDEO_MB },
            { key: 'MAX_VIDEO_SECONDS', label: 'Longest video (seconds)', value: env.MAX_VIDEO_SECONDS },
            { key: 'STORY_LIFETIME_HOURS', label: 'Stories disappear after (hours)', value: env.STORY_LIFETIME_HOURS },
            { key: 'ACCOUNT_DELETION_GRACE_DAYS', label: 'Days before a deleted account is erased', value: env.ACCOUNT_DELETION_GRACE_DAYS },
            { key: 'NOTIFICATION_RETENTION_DAYS', label: 'Days notifications are kept', value: env.NOTIFICATION_RETENTION_DAYS },
            { key: 'EXPOSE_OTP_IN_RESPONSE', label: 'Show codes in API responses (testing only)', value: env.EXPOSE_OTP_IN_RESPONSE, danger: env.EXPOSE_OTP_IN_RESPONSE },
        ],
    };
};

module.exports = {
    queues,
    overview,
    analytics,
    listUsers,
    getUser,
    logoutEverywhere,
    verifyEmail,
    clearProfile,
    listPosts,
    getPost,
    listComments,
    listStories,
    listHashtags,
    listAuthEvents,
    system,
};
