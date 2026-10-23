const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const notifications = require('../src/services/notificationService');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const { api, prisma, resetDb, signup, bearer } = require('./helpers');

const USERS = '/api/v1/users';
const POSTS = '/api/v1/posts';
const SEARCH = '/api/v1/search';

before(resetDb);
after(async () => {
    await notifications.settle();
    await prisma.$disconnect();
});

const newUser = async (overrides = {}) => {
    const { user, accessToken } = await signup(overrides);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return { id: user.id, username: user.username, auth: bearer(accessToken) };
};

const createPost = async (who, body) => {
    const res = await api().post(POSTS).set(who.auth).send({ category: 'Environment', description: 'A volunteering day.', ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.post;
};

const search = async (who, kind, q, extra = {}) => {
    const res = await api().get(`${SEARCH}/${kind}`).query({ q, ...extra }).set(who.auth);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
};

describe('search people', () => {
    it('ranks exact and prefix username matches first, finds names, cities and small typos', async () => {
        const me = await newUser();
        const exact = await newUser({ username: 'meera', name: 'Meera Iyer' });
        const prefix = await newUser({ username: 'meera_volunteers', name: 'Some Group' });
        const byName = await newUser({ username: 'mi_chennai', name: 'Meera Krishnan' });
        await api().patch(`${USERS}/me`).set(byName.auth).send({ city: 'Chennai' });

        const { users } = await search(me, 'users', 'meera');
        assert.deepEqual(users.slice(0, 3).map((u) => u.id), [exact.id, prefix.id, byName.id]);
        assert.equal(users[0].followStatus, 'none');

        assert.deepEqual((await search(me, 'users', '@MEERA')).users[0].id, exact.id, '"@" and case are ignored');
        assert.ok((await search(me, 'users', 'chennai')).users.some((u) => u.id === byName.id && u.city === 'Chennai'));
        assert.ok((await search(me, 'users', 'meeraa')).users.some((u) => u.id === exact.id), 'typo still matches');
    });

    it('leaves out blocked and inactive people; "%" and "_" are literal', async () => {
        const me = await newUser();
        const blocked = await newUser({ username: 'zed_blocked' });
        const blocker = await newUser({ username: 'zed_blocker' });
        const gone = await newUser({ username: 'zed_gone' });
        const visible = await newUser({ username: 'zed_visible' });
        await api().post(`${USERS}/${blocked.username}/block`).set(me.auth);
        await api().post(`${USERS}/${me.username}/block`).set(blocker.auth);
        await prisma.user.update({ where: { id: gone.id }, data: { status: 'DEACTIVATED' } });

        const ids = (await search(me, 'users', 'zed_')).users.map((u) => u.id);
        assert.deepEqual(ids, [visible.id]);
        assert.equal((await search(me, 'users', '%')).users.length, 0);
    });

    it('pages with a cursor and validates q', async () => {
        const me = await newUser();
        for (let i = 0; i < 3; i += 1) await newUser({ username: `pager_${i}` });
        const page1 = await search(me, 'users', 'pager_', { limit: 2 });
        assert.equal(page1.users.length, 2);
        const page2 = await search(me, 'users', 'pager_', { limit: 2, cursor: page1.nextCursor });
        assert.equal(page2.users.length, 1);
        assert.equal(page2.nextCursor, null);
        assert.equal(new Set([...page1.users, ...page2.users].map((u) => u.id)).size, 3);

        assert.equal((await api().get(`${SEARCH}/users`).query({ q: '  ' }).set(me.auth)).status, 400);
        assert.equal((await api().get(`${SEARCH}/users`).query({ q: 'x', cursor: 'bad' }).set(me.auth)).status, 400);
        assert.equal((await api().get(`${SEARCH}/users`).query({ q: 'x' })).status, 401);
    });
});

describe('search posts', () => {
    it('matches title, description, location, category and author name; respects visibility', async () => {
        const me = await newUser();
        const author = await newUser({ name: 'Ravi Kumar' });
        const privateAuthor = await newUser();
        await api().patch(`${USERS}/me`).set(privateAuthor.auth).send({ isPrivate: true });

        const byTitle = await createPost(author, { title: 'Mangrove planting' });
        const byText = await createPost(author, { title: 'Sunday drive', description: 'We planted MANGROVE saplings', location: 'Thane' });
        const hidden = await createPost(privateAuthor, { title: 'Mangrove secret' });

        const ids = (await search(me, 'posts', 'mangrove')).posts.map((p) => p.id);
        assert.deepEqual(ids, [byText.id, byTitle.id], 'newest first, private account left out');
        assert.ok(!ids.includes(hidden.id));

        assert.ok((await search(me, 'posts', 'thane')).posts.some((p) => p.id === byText.id));
        assert.ok((await search(me, 'posts', 'ravi kumar')).posts.some((p) => p.id === byTitle.id));
        assert.ok((await search(me, 'posts', 'environment')).posts.length >= 2);
    });
});

describe('hashtags', () => {
    it('are taken from the title and description, lower-cased, and shown on the post', async () => {
        const me = await newUser();
        const post = await createPost(me, { title: 'Beach day #CleanSeas', description: 'Join us! #cleanseas #Mumbai #स्वच्छता' });
        assert.deepEqual(post.hashtags.sort(), ['cleanseas', 'mumbai', 'स्वच्छता'].sort());

        const tag = await prisma.hashtag.findUnique({ where: { name: 'cleanseas' } });
        assert.equal(tag.postsCount, 1);
    });

    it('search by prefix (with or without "#"), most used first, and open a hashtag page', async () => {
        const me = await newUser();
        const other = await newUser();
        await createPost(me, { title: 'One #treeplanting' });
        await createPost(other, { title: 'Two #treeplanting' });
        await createPost(other, { title: 'Three #trees' });

        const { hashtags } = await search(me, 'hashtags', '#tree');
        assert.deepEqual(hashtags.slice(0, 2), [
            { name: 'treeplanting', postsCount: 2 },
            { name: 'trees', postsCount: 1 },
        ]);
        assert.deepEqual((await search(me, 'hashtags', 'trees')).hashtags[0], { name: 'trees', postsCount: 1 }, 'exact match first');

        const res = await api().get('/api/v1/hashtags/TreePlanting/posts').set(me.auth);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.hashtag, { name: 'treeplanting', postsCount: 2 });
        assert.equal(res.body.data.posts.length, 2);
        assert.equal((await api().get('/api/v1/hashtags/nothing_here/posts').set(me.auth)).status, 404);
        assert.equal((await api().get('/api/v1/hashtags/bad-tag/posts').set(me.auth)).status, 400);
    });

    it('editing and deleting keep the counts right; posts search finds tags too', async () => {
        const me = await newUser();
        const post = await createPost(me, { title: 'Food drive #hunger' });
        let res = await api().patch(`${POSTS}/${post.id}`).set(me.auth).send({ description: 'Now with #zerohunger' });
        assert.deepEqual(res.body.data.post.hashtags.sort(), ['hunger', 'zerohunger']);

        res = await api().patch(`${POSTS}/${post.id}`).set(me.auth).send({ title: 'Food drive' });
        assert.deepEqual(res.body.data.post.hashtags, ['zerohunger']);
        assert.equal((await prisma.hashtag.findUnique({ where: { name: 'hunger' } })).postsCount, 0);

        assert.ok((await search(me, 'posts', 'zerohunger')).posts.some((p) => p.id === post.id));

        await api().delete(`${POSTS}/${post.id}`).set(me.auth);
        assert.equal((await prisma.hashtag.findUnique({ where: { name: 'zerohunger' } })).postsCount, 0);
        assert.equal((await search(me, 'hashtags', 'zerohunger')).hashtags.length, 0, 'unused tags are not suggested');
    });

    it('the cleanup job recounts after a purge and drops unused tags', async () => {
        const me = await newUser();
        const gone = await newUser();
        await createPost(me, { title: 'Shared #purgetest' });
        await createPost(gone, { title: 'Mine #purgetest #onlymine' });
        await prisma.user.update({ where: { id: gone.id }, data: { status: 'PENDING_DELETION', deletionScheduledAt: new Date() } });
        await prisma.hashtag.updateMany({ where: { name: 'onlymine' }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });

        await runAuthCleanup();
        assert.equal((await prisma.hashtag.findUnique({ where: { name: 'purgetest' } })).postsCount, 1);
        assert.equal(await prisma.hashtag.count({ where: { name: 'onlymine' } }), 0);
    });
});
