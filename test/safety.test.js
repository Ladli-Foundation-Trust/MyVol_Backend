const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const notifications = require('../src/services/notificationService');
const { api, AUTH, prisma, resetDb, signup, bearer } = require('./helpers');

const USERS = '/api/v1/users';
const POSTS = '/api/v1/posts';
const COMMENTS = '/api/v1/comments';
const REPORTS = '/api/v1/reports';
const ADMIN = '/api/v1/admin';
const NOTIFS = '/api/v1/notifications';

before(resetDb);
after(async () => {
    await notifications.settle();
    await prisma.$disconnect();
});

// A signed-in, verified user; role: 'REVIEWER' | 'ADMIN' for staff.
const newUser = async ({ role, name } = {}) => {
    const { user, accessToken, body } = await signup(name ? { name } : {});
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), ...(role && { role }) } });
    return { id: user.id, username: user.username, auth: bearer(accessToken), password: body.password, email: body.email };
};

const createPost = async (who, overrides = {}) => {
    const res = await api()
        .post(POSTS)
        .set(who.auth)
        .send({ title: 'Beach cleanup', description: 'Collected 40 kg of plastic.', category: 'Environment', ...overrides });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.post;
};

const comment = async (who, postId, text) => {
    const res = await api().post(`${POSTS}/${postId}/comments`).set(who.auth).send({ text });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.comment;
};

const follow = (who, target) => api().post(`${USERS}/${target.username}/follow`).set(who.auth);
const block = (who, target) => api().post(`${USERS}/${target.username}/block`).set(who.auth);
const unblock = (who, target) => api().delete(`${USERS}/${target.username}/block`).set(who.auth);
const report = (who, body) => api().post(REPORTS).set(who.auth).send(body);
const counts = async (u) =>
    prisma.user.findUnique({ where: { id: u.id }, select: { followersCount: true, followingCount: true } });

describe('block', () => {
    it('hides each from the other: profile, posts, comments, likes and lists', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const carol = await newUser();
        const post = await createPost(alice);
        await comment(bob, post.id, 'Bob was here');
        await api().post(`${POSTS}/${post.id}/like`).set(bob.auth);
        await follow(carol, alice);
        await follow(bob, carol);

        assert.equal((await block(alice, bob)).status, 200);

        // Bob can't find Alice at all.
        assert.equal((await api().get(`${USERS}/${alice.username}`).set(bob.auth)).status, 404);
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(bob.auth)).status, 404);
        assert.equal((await api().get(`${USERS}/${alice.username}/posts`).set(bob.auth)).status, 404);
        assert.equal((await follow(bob, alice)).status, 404);
        const explore = await api().get(`${POSTS}/explore`).set(bob.auth);
        assert.ok(!explore.body.data.posts.some((p) => p.id === post.id));

        // Alice still sees Bob's profile, flagged, with no content.
        const profile = (await api().get(`${USERS}/${bob.username}`).set(alice.auth)).body.data.profile;
        assert.equal(profile.blockedByMe, true);
        assert.equal(profile.canViewContent, false);
        assert.equal(profile.details, null);
        assert.equal((await follow(alice, bob)).body.code, 'USER_BLOCKED');

        // Bob's comment and like are hidden from Alice; Carol (no block) still sees them.
        assert.equal((await api().get(`${POSTS}/${post.id}/comments`).set(alice.auth)).body.data.comments.length, 0);
        assert.equal((await api().get(`${POSTS}/${post.id}/comments`).set(carol.auth)).body.data.comments.length, 1);
        assert.equal((await api().get(`${POSTS}/${post.id}/likes`).set(alice.auth)).body.data.users.length, 0);

        // Bob follows Carol, but Carol's followers list, seen by Alice, leaves him out.
        const followers = await api().get(`${USERS}/${carol.username}/followers`).set(alice.auth);
        assert.ok(!followers.body.data.users.some((u) => u.id === bob.id));
    });

    it('removes follows both ways with the counters, pending requests and notifications', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(alice, bob);
        await follow(bob, alice);
        assert.equal((await counts(alice)).followersCount, 1);

        await block(alice, bob);
        assert.deepEqual(await counts(alice), { followersCount: 0, followingCount: 0 });
        assert.deepEqual(await counts(bob), { followersCount: 0, followingCount: 0 });
        assert.equal(await prisma.notification.count({ where: { OR: [{ recipientId: alice.id }, { recipientId: bob.id }] } }), 0);

        // Private account: Bob's pending request to Carol goes when Carol blocks him.
        const carol = await newUser();
        await api().patch(`${USERS}/me`).set(carol.auth).send({ isPrivate: true });
        await follow(bob, carol);
        await block(carol, bob);
        assert.equal(await prisma.followRequest.count({ where: { requesterId: bob.id } }), 0);
    });

    it('stops new notifications between them', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const carol = await newUser();
        const post = await createPost(carol);
        const alicesComment = await comment(alice, post.id, 'Lovely');
        await block(alice, bob);

        // Bob can still see Carol's post and reply to Alice's comment (Carol didn't block
        // him), but Alice is not notified.
        const res = await api().post(`${POSTS}/${post.id}/comments`).set(bob.auth).send({ text: 'hi', parentId: alicesComment.id });
        assert.equal(res.status, 201);
        await notifications.settle();
        assert.equal(await prisma.notification.count({ where: { recipientId: alice.id, actorId: bob.id } }), 0);
    });

    it('lists blocked accounts; unblocking restores visibility (not the follows)', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice);
        await block(alice, bob);
        await block(alice, bob); // repeat is harmless

        const list = await api().get(`${USERS}/me/blocked`).set(alice.auth);
        assert.deepEqual(list.body.data.users.map((u) => u.id), [bob.id]);
        assert.ok(list.body.data.users[0].blockedAt);

        await unblock(alice, bob);
        assert.equal((await api().get(`${USERS}/${alice.username}`).set(bob.auth)).status, 200);
        assert.equal((await api().get(`${USERS}/me/blocked`).set(alice.auth)).body.data.users.length, 0);
        assert.equal((await counts(alice)).followersCount, 0);
    });

    it("can't block yourself", async () => {
        const alice = await newUser();
        const res = await block(alice, alice);
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'CANNOT_TARGET_SELF');
    });
});

describe('mute', () => {
    it("removes the muted person's posts from home and explore, nothing else", async () => {
        const alice = await newUser();
        const bob = await newUser();
        const post = await createPost(bob, { title: 'Muted post' });
        await follow(alice, bob);
        const inFeed = async (path) => (await api().get(`${POSTS}/${path}`).set(alice.auth)).body.data.posts.some((p) => p.id === post.id);
        assert.equal(await inFeed('feed'), true);

        const res = await api().post(`${USERS}/${bob.username}/mute`).set(alice.auth);
        assert.deepEqual(res.body.data, { muted: true });
        assert.equal(await inFeed('feed'), false);
        assert.equal(await inFeed('explore?limit=50'), false);
        // Still on his profile and by link, and still followed.
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(alice.auth)).status, 200);
        const profile = (await api().get(`${USERS}/${bob.username}`).set(alice.auth)).body.data.profile;
        assert.equal(profile.mutedByMe, true);
        assert.equal(profile.followStatus, 'following');

        const list = await api().get(`${USERS}/me/muted`).set(alice.auth);
        assert.deepEqual(list.body.data.users.map((u) => u.id), [bob.id]);

        await api().delete(`${USERS}/${bob.username}/mute`).set(alice.auth);
        assert.equal(await inFeed('feed'), true);
    });
});

describe('reports', () => {
    it('reports a post once per person (anonymous), never your own', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const post = await createPost(alice);

        let res = await report(bob, { type: 'post', targetId: post.id, reason: 'spam', details: 'Advertising' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.data.report.status, 'OPEN');
        assert.equal(res.body.data.alreadyReported, false);

        res = await report(bob, { type: 'post', targetId: post.id, reason: 'scam' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.alreadyReported, true);

        res = await report(alice, { type: 'post', targetId: post.id, reason: 'spam' });
        assert.equal(res.body.code, 'CANNOT_REPORT_SELF');
        // Nobody is notified about reports.
        await notifications.settle();
        assert.equal(await prisma.notification.count({ where: { recipientId: alice.id } }), 0);
    });

    it('reports comments and users; validates the input', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const post = await createPost(alice);
        const c = await comment(bob, post.id, 'rude words');

        assert.equal((await report(alice, { type: 'comment', targetId: c.id, reason: 'harassment' })).status, 201);
        const res = await report(alice, { type: 'user', targetId: bob.username, reason: 'fake_account' });
        assert.equal(res.status, 201);
        const row = await prisma.report.findUnique({ where: { id: res.body.data.report.id } });
        assert.equal(row.userId, bob.id);

        assert.equal((await report(alice, { type: 'post', targetId: 'nope', reason: 'spam' })).status, 400);
        assert.equal((await report(alice, { type: 'post', targetId: post.id, reason: 'boring' })).status, 400);
        assert.equal((await report(alice, { type: 'user', targetId: 'no_such_user', reason: 'spam' })).status, 404);
    });

    it('you can only report what you can see', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await api().patch(`${USERS}/me`).set(alice.auth).send({ isPrivate: true });
        const post = await createPost(alice);
        const res = await report(bob, { type: 'post', targetId: post.id, reason: 'spam' });
        assert.equal(res.status, 403);
        assert.equal(res.body.code, 'PRIVATE_ACCOUNT');
    });

    it('"Report a problem" from the app', async () => {
        const alice = await newUser();
        let res = await api().post(`${REPORTS}/problem`).set(alice.auth).send({
            category: 'bug',
            details: 'The map screen crashes when I zoom out.',
            deviceInfo: 'app v1.0.0, Android 14',
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.data.report.type, 'problem');
        res = await api().post(`${REPORTS}/problem`).set(alice.auth).send({ category: 'bug', details: 'too short' });
        assert.equal(res.status, 400);
    });

    it('hides a post reported by REPORT_AUTO_HIDE_THRESHOLD (5) people until reviewed', async () => {
        const alice = await newUser();
        const post = await createPost(alice);
        for (let i = 0; i < 5; i += 1) {
            const reporter = await newUser();
            await report(reporter, { type: 'post', targetId: post.id, reason: 'nudity' });
            const { status } = await prisma.post.findUnique({ where: { id: post.id }, select: { status: true } });
            assert.equal(status, i < 4 ? 'APPROVED' : 'UNDER_REVIEW');
        }
        const viewer = await newUser();
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(viewer.auth)).status, 404);
        // The author still sees it, under review.
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(alice.auth)).body.data.post.status, 'UNDER_REVIEW');
        const action = await prisma.moderationAction.findFirst({ where: { targetId: post.id } });
        assert.equal(action.action, 'AUTO_HIDE_POST');
        assert.equal(action.moderatorId, null);
    });

    it('needs a login', async () => {
        assert.equal((await api().post(REPORTS).send({})).status, 401);
    });
});

describe('moderation', () => {
    it('is for staff only', async () => {
        const user = await newUser();
        const reviewer = await newUser({ role: 'REVIEWER' });
        assert.equal((await api().get(`${ADMIN}/posts`).set(user.auth)).status, 403);
        assert.equal((await api().get(`${ADMIN}/posts`).set(reviewer.auth)).status, 200);
        // Suspensions, roles and the audit log are admin-only.
        const res = await api().post(`${ADMIN}/users/${user.id}/suspend`).set(reviewer.auth).send({ reason: 'testing' });
        assert.equal(res.status, 403);
        assert.equal((await api().get(`${ADMIN}/actions`).set(reviewer.auth)).status, 403);
    });

    it('review queue: approve notifies the author; reject hides the post with a reason', async () => {
        const reviewer = await newUser({ role: 'REVIEWER' });
        const alice = await newUser();
        const viewer = await newUser();
        const post = await createPost(alice, { title: 'Food drive' });
        await prisma.post.update({ where: { id: post.id }, data: { status: 'UNDER_REVIEW' } });

        const queue = await api().get(`${ADMIN}/posts`).set(reviewer.auth);
        const queued = queue.body.data.posts.find((p) => p.id === post.id);
        assert.ok(queued);
        assert.deepEqual(queued.openReports, { count: 0, reasons: {} });

        let res = await api().post(`${ADMIN}/posts/${post.id}/approve`).set(reviewer.auth);
        assert.equal(res.status, 200);
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(viewer.auth)).status, 200);
        await notifications.settle();
        let [n] = (await api().get(NOTIFS).set(alice.auth)).body.data.notifications;
        assert.equal(n.type, 'approved');
        assert.equal(n.message, 'Your "Food drive" activity was approved.');

        res = await api().post(`${ADMIN}/posts/${post.id}/reject`).set(reviewer.auth).send({ reason: 'Not a volunteering activity' });
        assert.equal(res.status, 200);
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(viewer.auth)).status, 404);
        const own = (await api().get(`${POSTS}/${post.id}`).set(alice.auth)).body.data.post;
        assert.equal(own.status, 'REJECTED');
        assert.equal(own.rejectionReason, 'Not a volunteering activity');
        [n] = (await api().get(NOTIFS).set(alice.auth)).body.data.notifications;
        assert.equal(n.type, 'rejected');

        // Editing a rejected post sends it back for review (the author's appeal).
        await api().patch(`${POSTS}/${post.id}`).set(alice.auth).send({ title: 'Food drive (photos added)' });
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(alice.auth)).body.data.post.status, 'UNDER_REVIEW');

        assert.equal((await api().post(`${ADMIN}/posts/${post.id}/reject`).set(reviewer.auth).send({})).status, 400);
    });

    it('report queue: remove a post closes every report about it', async () => {
        const reviewer = await newUser({ role: 'REVIEWER' });
        const alice = await newUser();
        const post = await createPost(alice);
        const r1 = await newUser();
        const r2 = await newUser();
        await report(r1, { type: 'post', targetId: post.id, reason: 'hate_speech' });
        await report(r2, { type: 'post', targetId: post.id, reason: 'harassment', details: 'Targets a group' });

        const list = await api().get(`${ADMIN}/reports?type=post`).set(reviewer.auth);
        const mine = list.body.data.reports.filter((r) => r.post?.id === post.id);
        assert.equal(mine.length, 2);
        assert.equal(mine[0].openReportsOnTarget, 2);
        assert.equal(mine[0].user.id, alice.id); // about the author
        assert.equal(mine[0].reporter.id, r1.id); // staff see the reporter

        const res = await api().post(`${ADMIN}/reports/${mine[0].id}/resolve`).set(reviewer.auth).send({ action: 'remove', note: 'Hate speech' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.report.status, 'RESOLVED');
        assert.equal((await prisma.post.findUnique({ where: { id: post.id } })).status, 'REJECTED');
        assert.equal(await prisma.report.count({ where: { postId: post.id, status: 'OPEN' } }), 0);

        const again = await api().post(`${ADMIN}/reports/${mine[1].id}/resolve`).set(reviewer.auth).send({ action: 'dismiss' });
        assert.equal(again.body.code, 'REPORT_CLOSED');
    });

    it('report queue: dismiss, and remove a comment', async () => {
        const reviewer = await newUser({ role: 'REVIEWER' });
        const alice = await newUser();
        const bob = await newUser();
        const post = await createPost(alice);
        const c = await comment(bob, post.id, 'nasty comment');
        await report(alice, { type: 'comment', targetId: c.id, reason: 'harassment' });
        const other = await createPost(bob);
        await report(alice, { type: 'post', targetId: other.id, reason: 'spam' });

        const reports = (await api().get(`${ADMIN}/reports`).set(reviewer.auth)).body.data.reports;
        const commentReport = reports.find((r) => r.comment?.id === c.id);
        const postReport = reports.find((r) => r.post?.id === other.id);
        assert.equal(commentReport.comment.text, 'nasty comment');

        await api().post(`${ADMIN}/reports/${postReport.id}/resolve`).set(reviewer.auth).send({ action: 'dismiss', note: 'Not spam' });
        assert.equal((await prisma.report.findUnique({ where: { id: postReport.id } })).status, 'DISMISSED');
        assert.equal((await prisma.post.findUnique({ where: { id: other.id } })).status, 'APPROVED');

        await api().post(`${ADMIN}/reports/${commentReport.id}/resolve`).set(reviewer.auth).send({ action: 'remove' });
        assert.equal(await prisma.comment.count({ where: { id: c.id } }), 0);
        assert.equal((await prisma.post.findUnique({ where: { id: post.id } })).commentsCount, 0);
        const closed = await prisma.report.findUnique({ where: { id: commentReport.id } });
        assert.equal(closed.status, 'RESOLVED');
        assert.equal(closed.commentId, null, 'the report outlives the comment');
    });

    it('admin suspends: logged out, invisible, can\'t log in; unsuspend restores', async () => {
        const admin = await newUser({ role: 'ADMIN' });
        const bob = await newUser();
        const viewer = await newUser();
        const post = await createPost(bob);
        await report(viewer, { type: 'user', targetId: bob.id, reason: 'spam' });

        let res = await api().post(`${ADMIN}/users/${bob.id}/suspend`).set(admin.auth).send({ reason: 'Spam account' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await api().get(`${USERS}/me`).set(bob.auth)).status, 401);
        assert.equal((await api().get(`${USERS}/${bob.username}`).set(viewer.auth)).status, 404);
        assert.equal((await api().get(`${POSTS}/${post.id}`).set(viewer.auth)).status, 404);
        res = await api().post(`${AUTH}/login`).send({ identifier: bob.email, password: bob.password });
        assert.equal(res.body.code, 'ACCOUNT_SUSPENDED');
        assert.equal(await prisma.report.count({ where: { userId: bob.id, type: 'USER', status: 'OPEN' } }), 0);

        res = await api().post(`${ADMIN}/users/${bob.id}/unsuspend`).set(admin.auth);
        assert.equal(res.status, 200);
        assert.equal((await api().get(`${USERS}/${bob.username}`).set(viewer.auth)).status, 200);
        res = await api().post(`${AUTH}/login`).send({ identifier: bob.email, password: bob.password });
        assert.equal(res.status, 200);

        const log = (await api().get(`${ADMIN}/actions?targetId=${bob.id}`).set(admin.auth)).body.data.actions;
        assert.deepEqual(log.map((a) => a.action), ['UNSUSPEND_USER', 'SUSPEND_USER']);
        assert.equal(log[1].reason, 'Spam account');
        assert.equal(log[1].moderator.id, admin.id);
    });

    it('roles: admins change them, never their own or an admin\'s suspension', async () => {
        const admin = await newUser({ role: 'ADMIN' });
        const otherAdmin = await newUser({ role: 'ADMIN' });
        const bob = await newUser();

        let res = await api().post(`${ADMIN}/users/${bob.id}/role`).set(admin.auth).send({ role: 'reviewer' });
        assert.equal(res.body.data.user.role, 'REVIEWER');
        assert.equal((await api().get(`${ADMIN}/posts`).set(bob.auth)).status, 200, 'applies at once');

        res = await api().post(`${ADMIN}/users/${admin.id}/role`).set(admin.auth).send({ role: 'user' });
        assert.equal(res.body.code, 'CANNOT_TARGET_SELF');
        res = await api().post(`${ADMIN}/users/${otherAdmin.id}/suspend`).set(admin.auth).send({ reason: 'testing' });
        assert.equal(res.body.code, 'TARGET_IS_ADMIN');
    });
});
