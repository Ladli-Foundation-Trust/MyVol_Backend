const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const notifications = require('../src/services/notificationService');
const { api, prisma, resetDb, signup, bearer } = require('./helpers');

const USERS = '/api/v1/users';
const POSTS = '/api/v1/posts';
const ADMIN = '/api/v1/admin';
const NOTIFS = '/api/v1/notifications';

before(resetDb);
after(async () => {
    await notifications.settle();
    await prisma.$disconnect();
});

const newUser = async ({ role } = {}) => {
    const { user, accessToken } = await signup();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), ...(role && { role }) } });
    return { id: user.id, username: user.username, auth: bearer(accessToken) };
};

// POST_AUTO_APPROVE is on in tests, so these are APPROVED unless moved afterwards.
const createPost = async (who, overrides = {}) => {
    const res = await api()
        .post(POSTS)
        .set(who.auth)
        .send({ title: 'Beach cleanup', description: 'Collected plastic.', category: 'Environment', hours: 2, beneficiaries: 10, ...overrides });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.post;
};

const setStatus = (post, status) => prisma.post.update({ where: { id: post.id }, data: { status } });
const myImpact = async (who) => (await api().get(`${USERS}/me/impact`).set(who.auth)).body.data.impact;
const medalNotifications = async (who) => {
    await notifications.settle();
    const res = await api().get(NOTIFS).set(who.auth);
    return res.body.data.notifications.filter((n) => n.type === 'medal');
};

describe('impact stats', () => {
    it('add up approved activities only, with a per-category breakdown for the owner', async () => {
        const vol = await newUser();
        const a = await createPost(vol, { hours: 3, beneficiaries: 40, category: 'Health' });
        await createPost(vol, { hours: 2, beneficiaries: 15, category: 'Health' });
        await createPost(vol, { hours: 5, beneficiaries: 100, category: 'Education' });
        const pending = await createPost(vol, { hours: 20, beneficiaries: 999 });
        const rejected = await createPost(vol, { hours: 20, beneficiaries: 999 });
        await setStatus(pending, 'UNDER_REVIEW');
        await setStatus(rejected, 'REJECTED');
        await api().post(`${POSTS}/${a.id}/like`).set((await newUser()).auth);

        const impact = await myImpact(vol);
        assert.equal(impact.activities, 3);
        assert.equal(impact.hours, 10);
        assert.equal(impact.beneficiaries, 155);
        assert.equal(impact.likesReceived, 1);
        assert.equal(impact.underReview, 1);
        assert.equal(impact.rejected, 1);
        assert.deepEqual(impact.byCategory, [
            { category: 'Health', activities: 2, hours: 5, beneficiaries: 55 },
            { category: 'Education', activities: 1, hours: 5, beneficiaries: 100 },
        ]);
    });

    it('starts at zero, with Bronze as the next medal', async () => {
        const fresh = await newUser();
        const impact = await myImpact(fresh);
        assert.equal(impact.activities, 0);
        assert.equal(impact.hours, 0);
        assert.deepEqual(impact.byCategory, []);
        assert.equal(impact.medals.current, null);
        assert.deepEqual(impact.medals.next, { id: 'bronze', label: 'Bronze Medal', activities: 3, remaining: 3 });
        assert.deepEqual(impact.medals.tiers.map((t) => [t.id, t.activities, t.earned]), [
            ['bronze', 3, false],
            ['silver', 6, false],
            ['gold', 12, false],
            ['platinum', 25, false],
        ]);
    });

    it('is on every profile as a summary', async () => {
        const vol = await newUser();
        const viewer = await newUser();
        for (let i = 0; i < 3; i++) await createPost(vol, { hours: 1, beneficiaries: 5 });

        const own = (await api().get(`${USERS}/me`).set(vol.auth)).body.data.profile;
        assert.deepEqual(own.impact, { activities: 3, hours: 3, beneficiaries: 15, medal: 'bronze' });
        const theirs = (await api().get(`${USERS}/${vol.username}`).set(viewer.auth)).body.data.profile;
        assert.deepEqual(theirs.impact, own.impact);
    });

    it('shows a private account\'s totals but not what its activities were about', async () => {
        const vol = await newUser();
        const stranger = await newUser();
        await createPost(vol, { hours: 4, beneficiaries: 20 });
        await prisma.user.update({ where: { id: vol.id }, data: { isPrivate: true } });

        const res = await api().get(`${USERS}/${vol.username}/impact`).set(stranger.auth);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.impact.hours, 4);
        assert.equal(res.body.data.impact.byCategory, null);
        assert.equal(res.body.data.impact.underReview, undefined); // owner only
    });

    it('is hidden across a block', async () => {
        const vol = await newUser();
        const other = await newUser();
        await createPost(vol);
        assert.equal((await api().post(`${USERS}/${other.username}/block`).set(vol.auth)).status, 200);

        // The blocked person can't find the blocker; the blocker must unblock first.
        assert.equal((await api().get(`${USERS}/${vol.username}/impact`).set(other.auth)).status, 404);
        const res = await api().get(`${USERS}/${other.username}/impact`).set(vol.auth);
        assert.equal(res.status, 403);
        assert.equal(res.body.code, 'USER_BLOCKED');
        assert.equal((await api().get(`${USERS}/${other.username}`).set(vol.auth)).body.data.profile.impact, null);
    });
});

describe('medals', () => {
    it('notify once when an auto-approved post completes a tier', async () => {
        const vol = await newUser();
        await createPost(vol);
        await createPost(vol);
        assert.equal((await medalNotifications(vol)).length, 0);

        const third = await createPost(vol);
        const [n] = await medalNotifications(vol);
        assert.equal(n.message, 'You earned the Bronze Medal for 3 approved activities.');
        assert.equal(n.url, `myvolapp://user/${vol.id}`);
        assert.equal(n.actor, null);
        assert.equal((await myImpact(vol)).medals.current.id, 'bronze');
        assert.deepEqual((await myImpact(vol)).medals.next, { id: 'silver', label: 'Silver Medal', activities: 6, remaining: 3 });

        // Dropping below and reaching it again doesn't announce it twice.
        await api().delete(`${POSTS}/${third.id}`).set(vol.auth);
        assert.equal((await myImpact(vol)).medals.current, null);
        await createPost(vol);
        assert.equal((await medalNotifications(vol)).length, 1);
    });

    it('notify when a reviewer\'s approval completes a tier, not on a repeat approval', async () => {
        const vol = await newUser();
        const reviewer = await newUser({ role: 'REVIEWER' });
        await createPost(vol);
        await createPost(vol);
        const third = await createPost(vol);
        await setStatus(third, 'UNDER_REVIEW');
        await prisma.notification.deleteMany({ where: { recipientId: vol.id } }); // the auto-approve medal

        assert.equal((await api().post(`${ADMIN}/posts/${third.id}/approve`).set(reviewer.auth)).status, 200);
        assert.equal((await medalNotifications(vol)).length, 1);

        // Approving an approved post again changes nothing.
        await prisma.notification.deleteMany({ where: { recipientId: vol.id, type: 'MEDAL_EARNED' } });
        assert.equal((await api().post(`${ADMIN}/posts/${third.id}/approve`).set(reviewer.auth)).status, 200);
        assert.equal((await medalNotifications(vol)).length, 0);
    });

    it('lists every tier earned at 25 approved activities, with nothing next', async () => {
        const vol = await newUser();
        await prisma.post.createMany({
            data: Array.from({ length: 25 }, (_, i) => ({ authorId: vol.id, title: `Drive ${i}`, category: 'Health', status: 'APPROVED' })),
        });
        const { medals } = await myImpact(vol);
        assert.equal(medals.current.id, 'platinum');
        assert.equal(medals.next, null);
        assert.ok(medals.tiers.every((t) => t.earned));
    });
});
