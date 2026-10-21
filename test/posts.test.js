const fs = require('fs');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const storage = require('../src/lib/storage');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const { api, prisma, resetDb, signup, bearer } = require('./helpers');

const POSTS = '/api/v1/posts';
const USERS = '/api/v1/users';
const COMMENTS = '/api/v1/comments';

before(resetDb);
after(() => prisma.$disconnect());

// A signed-in, verified user (posting and commenting need a verified email or phone).
const newUser = async ({ verified = true } = {}) => {
    const { user, accessToken } = await signup();
    if (verified) await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return { id: user.id, username: user.username, auth: bearer(accessToken) };
};

const photo = (width, height, color = '#6754FD') =>
    sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();

const TEXT_POST = {
    title: 'Food drive',
    description: 'Served 120 meals at the shelter.',
    category: 'Hunger & Poverty',
    location: 'Mumbai, India',
    beneficiaries: 120,
    hours: 4,
};

// Text-only posts can be sent as JSON.
const createTextPost = async (who, overrides = {}) => {
    const res = await api().post(POSTS).set(who.auth).send({ ...TEXT_POST, ...overrides });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.post;
};

const getPost = (who, id) => api().get(`${POSTS}/${id}`).set(who.auth);
const follow = (who, target) => api().post(`${USERS}/${target.username}/follow`).set(who.auth);
const fileOf = (url) => path.join(storage.ROOT, url.split('/uploads/')[1]);

describe('create post', () => {
    it('accepts photos as multipart, resized and in order, with form fields as strings', async () => {
        const me = await newUser();
        const res = await api()
            .post(POSTS)
            .set(me.auth)
            .field('title', 'Tree plantation')
            .field('category', 'Environment')
            .field('location', 'New Delhi, India')
            .field('beneficiaries', '50')
            .field('hours', '2')
            .attach('media', await photo(3000, 2000), 'a.jpg')
            .attach('media', await photo(600, 900, '#00aa00'), 'b.jpg');
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const { post } = res.body.data;
        assert.equal(post.status, 'APPROVED'); // POST_AUTO_APPROVE until moderation ships
        assert.equal(post.beneficiaries, 50);
        assert.equal(post.isMine, true);
        assert.equal(post.author.id, me.id);
        assert.deepEqual(post.media.map((m) => [m.type, m.width, m.height]), [['image', 1440, 960], ['image', 600, 900]]);

        const meta = await sharp(fs.readFileSync(fileOf(post.media[0].url))).metadata();
        assert.equal(meta.format, 'webp');
    });

    it('allows a text-only post but then needs a description', async () => {
        const me = await newUser();
        await createTextPost(me);
        const res = await api().post(POSTS).set(me.auth).send({ title: 'Hi', category: 'Health' });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'DESCRIPTION_REQUIRED');
    });

    it('validates fields, files and the verified gate', async () => {
        const me = await newUser();
        const cases = [
            [{ ...TEXT_POST, category: 'Cooking' }, 'category'],
            [{ ...TEXT_POST, title: 'x'.repeat(61) }, 'title'],
            [{ ...TEXT_POST, hours: 30 }, 'hours'],
            [{ ...TEXT_POST, likesCount: 999 }, ''],
        ];
        for (const [body, field] of cases) {
            const res = await api().post(POSTS).set(me.auth).send(body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.equal(res.body.details[0].field, field);
        }

        let req = api().post(POSTS).set(me.auth).field('title', 'x').field('category', 'Health');
        for (let i = 0; i < 7; i++) req = req.attach('media', Buffer.from('x'), `${i}.jpg`);
        assert.equal((await req).body.code, 'INVALID_UPLOAD');

        const notImage = await api().post(POSTS).set(me.auth).field('title', 'x').field('category', 'Health').attach('media', Buffer.from('nope'), 'x.jpg');
        assert.equal(notImage.body.code, 'INVALID_IMAGE');

        const unverified = await newUser({ verified: false });
        const res = await api().post(POSTS).set(unverified.auth).send(TEXT_POST);
        assert.equal(res.status, 403);
        assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED');
    });
});

describe('edit / delete post', () => {
    it('lets only the author edit (marking it edited) and delete, which removes the files', async () => {
        const me = await newUser();
        const other = await newUser();
        const created = await api().post(POSTS).set(me.auth).field('title', 'Camp').field('category', 'Health').attach('media', await photo(800, 800), 'a.jpg');
        const post = created.body.data.post;

        const edit = await api().patch(`${POSTS}/${post.id}`).set(me.auth).send({ title: 'Health camp', hours: 5 });
        assert.equal(edit.status, 200);
        assert.equal(edit.body.data.post.title, 'Health camp');
        assert.ok(edit.body.data.post.editedAt);

        assert.equal((await api().patch(`${POSTS}/${post.id}`).set(other.auth).send({ title: 'Mine now' })).body.code, 'NOT_AUTHOR');
        assert.equal((await api().delete(`${POSTS}/${post.id}`).set(other.auth)).status, 403);

        assert.equal((await api().delete(`${POSTS}/${post.id}`).set(me.auth)).status, 200);
        assert.equal((await getPost(me, post.id)).status, 404);
        assert.equal(fs.existsSync(fileOf(post.media[0].url)), false);
    });

    it("won't let an edit empty a text-only post's description", async () => {
        const me = await newUser();
        const post = await createTextPost(me);
        const res = await api().patch(`${POSTS}/${post.id}`).set(me.auth).send({ description: '' });
        assert.equal(res.body.code, 'DESCRIPTION_REQUIRED');
    });
});

describe('visibility', () => {
    it('hides posts under review from everyone but the author', async () => {
        const me = await newUser();
        const other = await newUser();
        const post = await createTextPost(me);
        await prisma.post.update({ where: { id: post.id }, data: { status: 'UNDER_REVIEW' } });

        assert.equal((await getPost(me, post.id)).body.data.post.status, 'UNDER_REVIEW');
        assert.equal((await getPost(other, post.id)).status, 404);
        const grid = await api().get(`${USERS}/${me.username}/posts`).set(other.auth);
        assert.deepEqual(grid.body.data.posts, []);
        assert.equal((await api().get(`${USERS}/${me.username}`).set(other.auth)).body.data.profile.postsCount, 0);
        assert.equal((await api().get(`${USERS}/me`).set(me.auth)).body.data.profile.postsCount, 1);
    });

    it("keeps a private account's posts to approved followers", async () => {
        const owner = await newUser();
        const fan = await newUser();
        await api().patch(`${USERS}/me`).set(owner.auth).send({ isPrivate: true });
        const post = await createTextPost(owner);

        const locked = await getPost(fan, post.id);
        assert.equal(locked.status, 403);
        assert.equal(locked.body.code, 'PRIVATE_ACCOUNT');
        assert.equal((await api().post(`${POSTS}/${post.id}/like`).set(fan.auth)).status, 403);
        assert.equal((await api().get(`${USERS}/${owner.username}/posts`).set(fan.auth)).status, 403);

        await follow(fan, owner);
        await api().post(`${USERS}/me/follow-requests/${fan.id}/accept`).set(owner.auth);
        assert.equal((await getPost(fan, post.id)).status, 200);
    });

    it('hides posts of deactivated authors', async () => {
        const author = await newUser();
        const viewer = await newUser();
        const post = await createTextPost(author);
        await prisma.user.update({ where: { id: author.id }, data: { status: 'DEACTIVATED' } });
        assert.equal((await getPost(viewer, post.id)).status, 404);
    });
});

describe('feeds', () => {
    it('home: own posts and people you follow, newest first, paginated', async () => {
        const me = await newUser();
        const friend = await newUser();
        const stranger = await newUser();
        await follow(me, friend);

        const mine = await createTextPost(me, { title: 'mine' });
        const f1 = await createTextPost(friend, { title: 'friend 1' });
        await createTextPost(stranger, { title: 'stranger' });
        const f2 = await createTextPost(friend, { title: 'friend 2' });

        const page1 = await api().get(`${POSTS}/feed`).query({ limit: 2 }).set(me.auth);
        assert.equal(page1.status, 200, JSON.stringify(page1.body));
        assert.deepEqual(page1.body.data.posts.map((p) => p.id), [f2.id, f1.id]);
        assert.equal(page1.body.data.posts[0].author.followStatus, 'following');

        const page2 = await api().get(`${POSTS}/feed`).query({ limit: 2, cursor: page1.body.data.nextCursor }).set(me.auth);
        assert.deepEqual(page2.body.data.posts.map((p) => p.id), [mine.id]);
        assert.equal(page2.body.data.nextCursor, null);
    });

    it('explore: approved posts from public accounts, filtered by category and city', async () => {
        const viewer = await newUser();
        const pub = await newUser();
        const priv = await newUser();
        await api().patch(`${USERS}/me`).set(priv.auth).send({ isPrivate: true });

        const tag = `Town${Date.now()}`;
        const edu = await createTextPost(pub, { category: 'Education', location: `${tag}, India` });
        await createTextPost(pub, { category: 'Health', location: `${tag}, India` });
        await createTextPost(priv, { category: 'Education', location: `${tag}, India` });

        const res = await api().get(`${POSTS}/explore`).query({ category: 'Education', city: tag.toLowerCase() }).set(viewer.auth);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.data.posts.map((p) => p.id), [edu.id]);

        const both = await api().get(`${POSTS}/explore`).query({ category: 'Education,Health', city: tag }).set(viewer.auth);
        assert.equal(both.body.data.posts.length, 2);

        const bad = await api().get(`${POSTS}/explore`).query({ category: 'Cooking' }).set(viewer.auth);
        assert.equal(bad.status, 400);
    });
});

describe('likes, saves, shares', () => {
    it('count once per user and show likedByMe / savedByMe', async () => {
        const author = await newUser();
        const a = await newUser();
        const b = await newUser();
        const post = await createTextPost(author);

        assert.deepEqual((await api().post(`${POSTS}/${post.id}/like`).set(a.auth)).body.data, { liked: true, likesCount: 1 });
        await api().post(`${POSTS}/${post.id}/like`).set(a.auth); // repeat
        await api().post(`${POSTS}/${post.id}/like`).set(b.auth);
        assert.equal((await getPost(a, post.id)).body.data.post.likesCount, 2);
        assert.equal((await getPost(a, post.id)).body.data.post.likedByMe, true);
        assert.equal((await getPost(author, post.id)).body.data.post.likedByMe, false);

        const likers = await api().get(`${POSTS}/${post.id}/likes`).set(author.auth);
        assert.deepEqual(likers.body.data.users.map((u) => u.id), [b.id, a.id]);

        assert.deepEqual((await api().delete(`${POSTS}/${post.id}/like`).set(a.auth)).body.data, { liked: false, likesCount: 1 });
        assert.deepEqual((await api().delete(`${POSTS}/${post.id}/like`).set(a.auth)).body.data, { liked: false, likesCount: 1 });

        assert.deepEqual((await api().post(`${POSTS}/${post.id}/save`).set(a.auth)).body.data, { saved: true, savesCount: 1 });
        const saved = await api().get(`${POSTS}/saved`).set(a.auth);
        assert.equal(saved.body.data.posts[0].id, post.id);
        assert.equal(saved.body.data.posts[0].savedByMe, true);
        await api().delete(`${POSTS}/${post.id}/save`).set(a.auth);
        assert.deepEqual((await api().get(`${POSTS}/saved`).set(a.auth)).body.data.posts, []);

        assert.equal((await api().post(`${POSTS}/${post.id}/share`).set(b.auth)).body.data.sharesCount, 1);
    });

    it('survive concurrent double taps without double counting', async () => {
        const author = await newUser();
        const fan = await newUser();
        const post = await createTextPost(author);
        await Promise.all(Array.from({ length: 5 }, () => api().post(`${POSTS}/${post.id}/like`).set(fan.auth)));
        assert.equal((await getPost(fan, post.id)).body.data.post.likesCount, 1);
    });

    it('drop saved posts you can no longer see', async () => {
        const author = await newUser();
        const fan = await newUser();
        const post = await createTextPost(author);
        await api().post(`${POSTS}/${post.id}/save`).set(fan.auth);
        await api().patch(`${USERS}/me`).set(author.auth).send({ isPrivate: true });
        assert.deepEqual((await api().get(`${POSTS}/saved`).set(fan.auth)).body.data.posts, []);
    });
});

describe('comments', () => {
    it('threads one level deep, counts replies, and lists oldest first', async () => {
        const author = await newUser();
        const a = await newUser();
        const b = await newUser();
        const post = await createTextPost(author);
        const add = (who, body) => api().post(`${POSTS}/${post.id}/comments`).set(who.auth).send(body);

        const c1 = (await add(a, { text: 'Great work!' })).body.data.comment;
        const c2 = (await add(b, { text: 'Count me in' })).body.data.comment;
        const r1 = (await add(b, { text: 'Same!', parentId: c1.id })).body.data.comment;
        const r2 = (await add(a, { text: 'Thanks', parentId: r1.id })).body.data.comment; // reply to a reply
        assert.equal(r1.parentId, c1.id);
        assert.equal(r2.parentId, c1.id);

        assert.equal((await getPost(a, post.id)).body.data.post.commentsCount, 4);

        const top = await api().get(`${POSTS}/${post.id}/comments`).set(a.auth);
        assert.deepEqual(top.body.data.comments.map((c) => [c.id, c.repliesCount]), [[c1.id, 2], [c2.id, 0]]);

        const replies = await api().get(`${COMMENTS}/${c1.id}/replies`).set(author.auth);
        assert.deepEqual(replies.body.data.comments.map((c) => c.id), [r1.id, r2.id]);
        assert.equal(replies.body.data.comments[0].canDelete, true); // post author may delete any comment

        const empty = await add(a, { text: '   ' });
        assert.equal(empty.status, 400);
    });

    it('likes comments, and deleting a comment removes its replies and fixes the counts', async () => {
        const author = await newUser();
        const a = await newUser();
        const b = await newUser();
        const post = await createTextPost(author);
        const add = (who, body) => api().post(`${POSTS}/${post.id}/comments`).set(who.auth).send(body);

        const c1 = (await add(a, { text: 'First' })).body.data.comment;
        const r1 = (await add(b, { text: 'Reply 1', parentId: c1.id })).body.data.comment;
        await add(author, { text: 'Reply 2', parentId: c1.id });
        await add(b, { text: 'Second' });

        assert.deepEqual((await api().post(`${COMMENTS}/${c1.id}/like`).set(b.auth)).body.data, { liked: true, likesCount: 1 });
        await api().post(`${COMMENTS}/${c1.id}/like`).set(b.auth);
        const listed = (await api().get(`${POSTS}/${post.id}/comments`).set(b.auth)).body.data.comments[0];
        assert.equal(listed.likesCount, 1);
        assert.equal(listed.likedByMe, true);
        assert.equal(listed.canDelete, false);

        // Only the comment's author or the post's author may delete it.
        assert.equal((await api().delete(`${COMMENTS}/${c1.id}`).set(b.auth)).body.code, 'NOT_ALLOWED');

        assert.equal((await api().delete(`${COMMENTS}/${r1.id}`).set(b.auth)).status, 200);
        assert.equal((await getPost(a, post.id)).body.data.post.commentsCount, 3);
        assert.equal((await api().get(`${POSTS}/${post.id}/comments`).set(a.auth)).body.data.comments[0].repliesCount, 1);

        assert.equal((await api().delete(`${COMMENTS}/${c1.id}`).set(author.auth)).status, 200); // post author
        assert.equal((await getPost(a, post.id)).body.data.post.commentsCount, 1);
    });

    it('needs a verified account to comment, and a visible post', async () => {
        const author = await newUser();
        const unverified = await newUser({ verified: false });
        const post = await createTextPost(author);
        const res = await api().post(`${POSTS}/${post.id}/comments`).set(unverified.auth).send({ text: 'hi' });
        assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED');

        const missing = await api().post(`${POSTS}/00000000-0000-4000-8000-000000000000/comments`).set(author.auth).send({ text: 'hi' });
        assert.equal(missing.body.code, 'POST_NOT_FOUND');
    });
});

describe('account purge', () => {
    it("recounts likes, saves and comments on other people's posts and deletes the user's photos", async () => {
        const leaver = await newUser();
        const author = await newUser();
        const post = await createTextPost(author);
        const own = await api().post(POSTS).set(leaver.auth).field('title', 'Mine').field('category', 'Health').attach('media', await photo(400, 400), 'a.jpg');
        const photoFile = fileOf(own.body.data.post.media[0].url);

        const authorComment = (await api().post(`${POSTS}/${post.id}/comments`).set(author.auth).send({ text: 'Hello' })).body.data.comment;
        await api().post(`${POSTS}/${post.id}/like`).set(leaver.auth);
        await api().post(`${POSTS}/${post.id}/save`).set(leaver.auth);
        await api().post(`${COMMENTS}/${authorComment.id}/like`).set(leaver.auth);
        await api().post(`${POSTS}/${post.id}/comments`).set(leaver.auth).send({ text: 'Reply', parentId: authorComment.id });

        await prisma.user.update({
            where: { id: leaver.id },
            data: { status: 'PENDING_DELETION', deletionScheduledAt: new Date(Date.now() - 1000) },
        });
        await runAuthCleanup();

        const row = await prisma.post.findUnique({ where: { id: post.id } });
        assert.deepEqual([row.likesCount, row.savesCount, row.commentsCount], [0, 0, 1]);
        const comment = await prisma.comment.findUnique({ where: { id: authorComment.id } });
        assert.deepEqual([comment.likesCount, comment.repliesCount], [0, 0]);
        assert.equal(fs.existsSync(photoFile), false);
    });
});
