const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const app = require('../src/app');
const realtime = require('../src/lib/realtime');
const notifications = require('../src/services/notificationService');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const { api, AUTH, prisma, resetDb, signup, bearer } = require('./helpers');

const NOTIFS = '/api/v1/notifications';
const SETTINGS = '/api/v1/settings';
const POSTS = '/api/v1/posts';
const USERS = '/api/v1/users';
const COMMENTS = '/api/v1/comments';

// A real server on a random port, so the app's WebSocket can be tested end to end.
let server;
let live;
let wsUrl;

before(async () => {
    await resetDb();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    live = realtime.attach(server, { onReady: (user) => notifications.unreadCount(user.id) });
    wsUrl = `ws://127.0.0.1:${server.address().port}${realtime.PATH}`;
});

after(async () => {
    live.close();
    await new Promise((resolve) => server.close(resolve));
    await notifications.settle();
    await prisma.$disconnect();
});

// A signed-in, verified user.
const newUser = async ({ name } = {}) => {
    const { user, accessToken, refreshToken } = await signup(name ? { name } : {});
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return { id: user.id, username: user.username, name: user.name, token: accessToken, auth: bearer(accessToken), refreshToken };
};

// The app's side of the socket: every message lands in `messages`.
const open = (headers) => {
    const ws = new WebSocket(wsUrl, { headers });
    const client = { ws, messages: [], closed: null };
    ws.on('message', (raw) => client.messages.push(JSON.parse(raw.toString())));
    ws.on('close', (code, reason) => (client.closed = { code, reason: reason.toString() }));
    return client;
};

const waitFor = (check, what, timeoutMs = 2000) =>
    new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const value = check();
            if (value) return resolve(value);
            if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
            setTimeout(tick, 10);
        };
        tick();
    });

const nextMessage = (client, type) => waitFor(() => client.messages.find((m) => m.type === type), `a "${type}" message`);
const closed = (client) => waitFor(() => client.closed, 'the socket to close');

// Connects `who` like the app does: open, send the access token, wait for 'ready'.
const connect = async (who) => {
    const client = open();
    await new Promise((resolve, reject) => {
        client.ws.once('open', resolve);
        client.ws.once('error', reject);
    });
    client.ws.send(JSON.stringify({ type: 'auth', token: who.token }));
    await nextMessage(client, 'ready');
    return client;
};

// Lets background sends finish and their frames arrive, then returns what came in.
const received = async (client, type) => {
    await notifications.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return client.messages.filter((m) => m.type === type);
};

const list = async (who, query = {}) => {
    const res = await api().get(NOTIFS).query(query).set(who.auth);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
};

const unread = async (who) => (await api().get(`${NOTIFS}/unread-count`).set(who.auth)).body.data.unreadCount;

const follow = (who, target) => api().post(`${USERS}/${target.username}/follow`).set(who.auth);
const unfollow = (who, target) => api().delete(`${USERS}/${target.username}/follow`).set(who.auth);
const setSettings = (who, body) => api().patch(SETTINGS).set(who.auth).send(body);

const createPost = async (who, title = 'Beach cleanup') => {
    const res = await api()
        .post(POSTS)
        .set(who.auth)
        .send({ title, description: 'Collected 40 kg of plastic.', category: 'Environment' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.post;
};

const comment = async (who, postId, text, parentId) => {
    const res = await api().post(`${POSTS}/${postId}/comments`).set(who.auth).send({ text, ...(parentId && { parentId }) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.comment;
};

describe('the WebSocket', () => {
    it('logs in with a first { type: "auth" } message and reports the unread count', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice);

        const client = await connect(alice);
        const ready = client.messages[0];
        assert.deepEqual(ready, { type: 'ready', userId: alice.id, unreadCount: 1 });
        assert.equal(realtime.connectedDevices(alice.id), 1);
        client.ws.close();
        await closed(client);
        await waitFor(() => realtime.connectedDevices(alice.id) === 0, 'the device to be removed');
    });

    it('also accepts the token as an Authorization header', async () => {
        const alice = await newUser();
        const client = open({ Authorization: `Bearer ${alice.token}` });
        const ready = await nextMessage(client, 'ready');
        assert.equal(ready.userId, alice.id);
        client.ws.close();
    });

    it('closes with 4401 and the error code for a bad token', async () => {
        const client = open();
        await new Promise((resolve) => client.ws.once('open', resolve));
        client.ws.send(JSON.stringify({ type: 'auth', token: 'not-a-jwt' }));
        assert.deepEqual(await closed(client), { code: 4401, reason: 'TOKEN_INVALID' });
    });

    it('answers ping, and reports bad or early messages without closing', async () => {
        const client = open();
        await new Promise((resolve) => client.ws.once('open', resolve));
        client.ws.send(JSON.stringify({ type: 'ping' }));
        assert.equal((await nextMessage(client, 'error')).code, 'NOT_AUTHENTICATED');
        client.ws.close();

        const alice = await newUser();
        const authed = await connect(alice);
        authed.ws.send('not json');
        authed.ws.send(JSON.stringify({ type: 'ping' }));
        await nextMessage(authed, 'pong');
        assert.equal((await nextMessage(authed, 'error')).code, 'BAD_MESSAGE');
        assert.equal(authed.closed, null);
        authed.ws.close();
    });

    it('refuses other paths', async () => {
        const ws = new WebSocket(wsUrl.replace('/api/v1/ws', '/somewhere'));
        const err = await new Promise((resolve) => ws.once('error', resolve));
        assert.match(err.message, /404/);
    });

    it('disconnects a device whose session ended (logout)', async () => {
        const alice = await newUser();
        const client = await connect(alice);
        const res = await api().post(`${AUTH}/logout`).send({ refreshToken: alice.refreshToken });
        assert.equal(res.status, 200);

        await live.checkSessions(); // runs every 30 s on its own
        assert.deepEqual(await closed(client), { code: 4401, reason: 'SESSION_INVALID' });
    });

    it('test notification goes to every connected device', async () => {
        const alice = await newUser();
        const phone = await connect(alice);
        const tablet = await connect(alice);
        const res = await api().post(`${NOTIFS}/test`).set(alice.auth);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.devices, 2);
        assert.equal((await nextMessage(phone, 'test')).message, 'Notifications are working.');
        await nextMessage(tablet, 'test');
        phone.ws.close();
        tablet.ws.close();
    });
});

describe('follow notifications', () => {
    it('a follow is in the list and arrives live with the badge count and a banner', async () => {
        const alice = await newUser({ name: 'Alice Rao' });
        const bob = await newUser({ name: 'Bob Das' });
        const phone = await connect(alice);
        await follow(bob, alice);

        const data = await list(alice);
        assert.equal(data.unreadCount, 1);
        assert.equal(data.notifications.length, 1);
        const [n] = data.notifications;
        assert.equal(n.type, 'follow');
        assert.equal(n.message, 'Bob Das started following you.');
        assert.equal(n.actor.id, bob.id);
        assert.equal(n.actor.followsYou, true); // "Follow back"
        assert.equal(n.actor.followStatus, 'none');
        assert.equal(n.url, `myvolapp://user/${bob.id}`);
        assert.equal(n.read, false);
        assert.equal(n.post, null);

        const event = await nextMessage(phone, 'notification');
        assert.deepEqual(JSON.parse(JSON.stringify(event.notification)), JSON.parse(JSON.stringify(n)));
        assert.equal(event.unreadCount, 1);
        assert.deepEqual(event.alert, { sound: true, vibrate: true, channelId: 'default' });
        phone.ws.close();
    });

    it('following twice records once; unfollowing removes it; re-following within the hour shows no second banner', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const phone = await connect(alice);
        await follow(bob, alice);
        await follow(bob, alice);
        assert.equal((await list(alice)).notifications.length, 1);

        await unfollow(bob, alice);
        assert.equal((await list(alice)).notifications.length, 0);
        assert.equal(await unread(alice), 0);
        const counts = await received(phone, 'unread_count');
        assert.equal(counts.at(-1).unreadCount, 0, 'the badge drops live');

        await follow(bob, alice);
        assert.equal((await list(alice)).notifications.length, 1);
        const events = await received(phone, 'notification');
        assert.equal(events.length, 2);
        assert.ok(events[0].alert);
        assert.equal(events[1].alert, null, 'the list updates, but no second banner');
        phone.ws.close();
    });

    it('private account: request → accept turns into "started following you" and tells the requester', async () => {
        const carol = await newUser({ name: 'Carol' });
        const dan = await newUser({ name: 'Dan' });
        await api().patch(`${USERS}/me`).set(carol.auth).send({ isPrivate: true });

        assert.equal((await follow(dan, carol)).body.data.followStatus, 'requested');
        let [n] = (await list(carol)).notifications;
        assert.equal(n.type, 'follow_request');
        assert.equal(n.message, 'Dan requested to follow you.');

        const dansPhone = await connect(dan);
        const res = await api().post(`${USERS}/me/follow-requests/${dan.id}/accept`).set(carol.auth);
        assert.equal(res.status, 200);

        const carolsList = await list(carol);
        assert.equal(carolsList.notifications.length, 1);
        [n] = carolsList.notifications;
        assert.equal(n.type, 'follow');
        assert.equal(n.read, true, 'she acted on it, so it is read');
        assert.equal(carolsList.unreadCount, 0);

        const [accepted] = (await list(dan)).notifications;
        assert.equal(accepted.type, 'follow_accepted');
        assert.equal(accepted.message, 'Carol accepted your follow request.');
        assert.equal(accepted.actor.followStatus, 'following');
        assert.equal((await nextMessage(dansPhone, 'notification')).notification.type, 'follow_accepted');
        dansPhone.ws.close();
    });

    it('a declined or cancelled request disappears', async () => {
        const carol = await newUser();
        const dan = await newUser();
        const erin = await newUser();
        await api().patch(`${USERS}/me`).set(carol.auth).send({ isPrivate: true });

        await follow(dan, carol);
        await follow(erin, carol);
        assert.equal((await list(carol)).notifications.length, 2);

        await api().delete(`${USERS}/me/follow-requests/${dan.id}`).set(carol.auth);
        await unfollow(erin, carol); // cancels the request
        assert.equal((await list(carol)).notifications.length, 0);
    });

    it('going public turns pending requests into follows', async () => {
        const carol = await newUser();
        const dan = await newUser();
        await api().patch(`${USERS}/me`).set(carol.auth).send({ isPrivate: true });
        await follow(dan, carol);
        await api().patch(`${USERS}/me`).set(carol.auth).send({ isPrivate: false });

        const [n] = (await list(carol)).notifications;
        assert.equal(n.type, 'follow');
    });
});

describe('post and comment notifications', () => {
    it('a like notifies the author with the post; unlike removes it; own likes and saves are silent', async () => {
        const alice = await newUser();
        const bob = await newUser({ name: 'Bob' });
        const post = await createPost(alice, 'Tree plantation');
        const phone = await connect(alice);

        await api().post(`${POSTS}/${post.id}/like`).set(alice.auth);
        assert.equal((await list(alice)).notifications.length, 0);

        await api().post(`${POSTS}/${post.id}/like`).set(bob.auth);
        const [n] = (await list(alice)).notifications;
        assert.equal(n.type, 'like');
        assert.equal(n.message, 'Bob liked your activity "Tree plantation".');
        assert.deepEqual(n.post, { id: post.id, title: 'Tree plantation', thumbnailUrl: null });
        assert.equal(n.url, `myvolapp://post/${post.id}`);
        assert.equal((await nextMessage(phone, 'notification')).notification.post.id, post.id);

        await api().delete(`${POSTS}/${post.id}/like`).set(bob.auth);
        assert.equal((await list(alice)).notifications.length, 0);
        assert.equal((await received(phone, 'unread_count')).at(-1).unreadCount, 0);

        await api().post(`${POSTS}/${post.id}/save`).set(bob.auth);
        assert.equal((await list(alice)).notifications.length, 0);
        phone.ws.close();
    });

    it('comments notify the post author; replies notify the comment author instead', async () => {
        const alice = await newUser({ name: 'Alice' });
        const bob = await newUser({ name: 'Bob' });
        const carol = await newUser({ name: 'Carol' });
        const post = await createPost(alice);

        const bobs = await comment(bob, post.id, 'Count me in next time!');
        let [n] = (await list(alice)).notifications;
        assert.equal(n.type, 'comment');
        assert.equal(n.message, 'Bob commented: Count me in next time!');
        assert.deepEqual(n.comment, { id: bobs.id, text: 'Count me in next time!' });

        // Alice (post author) replies to Bob: Bob gets "replied", Alice nothing (her own action).
        await comment(alice, post.id, 'Thank you!', bobs.id);
        [n] = (await list(bob)).notifications;
        assert.equal(n.type, 'reply');
        assert.equal(n.message, 'Alice replied to your comment: Thank you!');
        assert.equal((await list(alice)).notifications.length, 1);

        // Carol replies to Bob: Bob gets "replied", Alice gets "commented".
        await comment(carol, post.id, 'Same here', bobs.id);
        assert.equal((await list(bob)).notifications[0].message, 'Carol replied to your comment: Same here');
        assert.equal((await list(alice)).notifications[0].message, 'Carol commented: Same here');

        // Deleting Bob's comment (and its replies) takes their notifications with it,
        // and the badge on Bob's phone drops live.
        const bobsPhone = await connect(bob);
        await api().delete(`${COMMENTS}/${bobs.id}`).set(bob.auth);
        assert.equal((await list(alice)).notifications.length, 0);
        assert.equal((await list(bob)).notifications.length, 0);
        assert.equal((await received(bobsPhone, 'unread_count')).at(-1).unreadCount, 0);
        bobsPhone.ws.close();
    });

    it('long comments are shortened in the message, not in `comment.text`', async () => {
        const alice = await newUser();
        const bob = await newUser({ name: 'Bob' });
        const post = await createPost(alice);
        const text = 'x'.repeat(200);
        await comment(bob, post.id, text);
        const [n] = (await list(alice)).notifications;
        assert.equal(n.message, `Bob commented: ${'x'.repeat(79)}…`);
        assert.equal(n.comment.text, text);
    });

    it('comment likes notify the comment author; unlike removes it', async () => {
        const alice = await newUser();
        const bob = await newUser({ name: 'Bob' });
        const post = await createPost(alice);
        const mine = await comment(alice, post.id, 'Join us on Sunday');

        await api().post(`${COMMENTS}/${mine.id}/like`).set(bob.auth);
        const [n] = (await list(alice)).notifications;
        assert.equal(n.type, 'comment_like');
        assert.equal(n.message, 'Bob liked your comment: Join us on Sunday');

        await api().delete(`${COMMENTS}/${mine.id}/like`).set(bob.auth);
        assert.equal((await list(alice)).notifications.length, 0);
    });

    it('deleting the post removes its notifications', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const post = await createPost(alice);
        await api().post(`${POSTS}/${post.id}/like`).set(bob.auth);
        await comment(bob, post.id, 'Nice');
        assert.equal((await list(alice)).notifications.length, 2);

        await api().delete(`${POSTS}/${post.id}`).set(alice.auth);
        assert.equal((await list(alice)).notifications.length, 0);
    });

    it('post reviews (moderation phase hook): approved, then rejected with a reason', async () => {
        const alice = await newUser();
        const post = await createPost(alice, 'Food drive');
        const phone = await connect(alice);

        const id = await prisma.$transaction((tx) => notifications.postReviewed(tx, { ...post, authorId: alice.id, status: 'APPROVED' }));
        notifications.deliver(id);
        let [n] = (await list(alice)).notifications;
        assert.equal(n.type, 'approved');
        assert.equal(n.message, 'Your "Food drive" activity was approved.');
        assert.equal(n.actor, null);
        assert.equal(n.url, `myvolapp://post/${post.id}`);
        assert.equal((await nextMessage(phone, 'notification')).notification.type, 'approved');

        await api().post(`${NOTIFS}/${n.id}/read`).set(alice.auth);
        await prisma.post.update({ where: { id: post.id }, data: { status: 'REJECTED', rejectionReason: 'No photos of the activity' } });
        await prisma.$transaction((tx) => notifications.postReviewed(tx, { ...post, authorId: alice.id, status: 'REJECTED' }));

        const data = await list(alice);
        assert.equal(data.notifications.length, 1, 'the second review replaces the first');
        [n] = data.notifications;
        assert.equal(n.type, 'rejected');
        assert.equal(n.message, 'Your "Food drive" activity wasn\'t approved: No photos of the activity');
        assert.equal(n.read, false);
        phone.ws.close();
    });
});

describe('reading notifications', () => {
    it('pages newest first and marks read one, all, or up to a time', async () => {
        const alice = await newUser();
        const fans = [];
        for (let i = 0; i < 3; i += 1) {
            const fan = await newUser();
            await follow(fan, alice);
            fans.push(fan);
        }

        const page1 = await list(alice, { limit: 2 });
        assert.equal(page1.notifications.length, 2);
        assert.equal(page1.notifications[0].actor.id, fans[2].id);
        assert.ok(page1.nextCursor);
        const page2 = await list(alice, { limit: 2, cursor: page1.nextCursor });
        assert.equal(page2.notifications.length, 1);
        assert.equal(page2.notifications[0].actor.id, fans[0].id);
        assert.equal(page2.nextCursor, null);

        let res = await api().post(`${NOTIFS}/${page2.notifications[0].id}/read`).set(alice.auth);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.unreadCount, 2);

        // Only up to the second-newest: the newest stays unread.
        res = await api().post(`${NOTIFS}/read-all`).set(alice.auth).send({ before: page1.notifications[1].createdAt });
        assert.equal(res.body.data.unreadCount, 1);

        res = await api().post(`${NOTIFS}/read-all`).set(alice.auth); // no body at all
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.unreadCount, 0);
        assert.equal(await unread(alice), 0);
    });

    it("reading on one device updates the badge on the user's other devices", async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice);
        const tablet = await connect(alice);
        assert.equal(tablet.messages[0].unreadCount, 1);

        await api().post(`${NOTIFS}/read-all`).set(alice.auth); // from the phone
        assert.equal((await nextMessage(tablet, 'unread_count')).unreadCount, 0);
        tablet.ws.close();
    });

    it("can delete a notification, but never touch someone else's", async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice);
        const [n] = (await list(alice)).notifications;

        let res = await api().post(`${NOTIFS}/${n.id}/read`).set(bob.auth);
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'NOTIFICATION_NOT_FOUND');
        res = await api().delete(`${NOTIFS}/${n.id}`).set(bob.auth);
        assert.equal(res.status, 404);

        res = await api().delete(`${NOTIFS}/${n.id}`).set(alice.auth);
        assert.equal(res.status, 200);
        assert.equal((await list(alice)).notifications.length, 0);

        res = await api().post(`${NOTIFS}/not-a-uuid/read`).set(alice.auth);
        assert.equal(res.status, 400);
    });

    it('hides notifications from deactivated users, in the list and the count', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice);
        assert.equal(await unread(alice), 1);

        await prisma.user.update({ where: { id: bob.id }, data: { status: 'DEACTIVATED' } });
        assert.equal(await unread(alice), 0);
        assert.equal((await list(alice)).notifications.length, 0);

        await prisma.user.update({ where: { id: bob.id }, data: { status: 'ACTIVE' } });
        assert.equal(await unread(alice), 1);
    });

    it('a device that was offline catches up from the list', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice); // alice's app is closed
        const phone = await connect(alice);
        assert.equal(phone.messages[0].unreadCount, 1);
        assert.equal((await list(alice)).notifications[0].type, 'follow');
        phone.ws.close();
    });

    it('needs a login', async () => {
        assert.equal((await api().get(NOTIFS)).status, 401);
        assert.equal((await api().get(SETTINGS)).status, 401);
    });
});

describe('settings', () => {
    it('returns the app defaults, merges changes and rejects bad input', async () => {
        const me = await newUser();
        let res = await api().get(SETTINGS).set(me.auth);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.settings.notifLikes, 'everyone');
        assert.equal(res.body.data.settings.pauseAll, false);
        assert.equal(res.body.data.settings.emailProductUpdates, false);

        res = await setSettings(me, { notifLikes: 'following', quietHours: true });
        assert.equal(res.status, 200);
        res = await setSettings(me, { notifComments: 'off' });
        const { settings } = res.body.data;
        assert.equal(settings.notifLikes, 'following', 'earlier changes are kept');
        assert.equal(settings.quietHours, true);
        assert.equal(settings.notifComments, 'off');

        assert.equal((await setSettings(me, { notifLikes: 'friends' })).status, 400);
        assert.equal((await setSettings(me, { privateAccount: true })).status, 400);
        assert.equal((await setSettings(me, {})).status, 400);
    });
});

describe('banners respect settings', () => {
    const alerts = async (phone) => (await received(phone, 'notification')).map((e) => e.alert);

    it('pauseAll and "off" stop the banner but still deliver the notification', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const post = await createPost(alice);
        const phone = await connect(alice);

        // Settings are read when the notification is sent (in the background), so each
        // send must finish before the next settings change.
        await setSettings(alice, { notifLikes: 'off' });
        await api().post(`${POSTS}/${post.id}/like`).set(bob.auth);
        await notifications.settle();
        await setSettings(alice, { notifLikes: 'everyone', pauseAll: true });
        await comment(bob, post.id, 'Great work');
        await notifications.settle();
        await setSettings(alice, { pauseAll: false });
        await comment(bob, post.id, 'Really');

        const got = await alerts(phone);
        assert.equal(got.length, 3, 'every notification reaches the app');
        assert.equal(got[0], null);
        assert.equal(got[1], null);
        assert.deepEqual(got[2], { sound: true, vibrate: true, channelId: 'default' });
        assert.equal((await list(alice)).notifications.length, 3);
        phone.ws.close();
    });

    it('"following" shows banners only for people the user follows', async () => {
        const alice = await newUser();
        const friend = await newUser();
        const stranger = await newUser();
        const post = await createPost(alice);
        await follow(alice, friend);
        await setSettings(alice, { notifComments: 'following' });
        const phone = await connect(alice);

        await comment(stranger, post.id, 'Hi');
        await comment(friend, post.id, 'Hi from a friend');
        const events = await received(phone, 'notification');
        assert.equal(events[0].alert, null);
        assert.ok(events[1].alert);
        assert.match(events[1].notification.message, /Hi from a friend/);
        phone.ws.close();
    });

    it('turning off new followers stops follow banners', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await setSettings(alice, { notifNewFollowers: false });
        const phone = await connect(alice);
        await follow(bob, alice);
        assert.deepEqual(await alerts(phone), [null]);
        phone.ws.close();
    });

    it('sound and vibration choose the Android channel', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await setSettings(alice, { notifSound: false });
        const phone = await connect(alice);
        await follow(bob, alice);
        assert.deepEqual(await alerts(phone), [{ sound: false, vibrate: true, channelId: 'vibrate-only' }]);
        phone.ws.close();
    });

    it('quiet hours are 22:00-07:00 in DEFAULT_TIMEZONE (Asia/Kolkata)', () => {
        assert.equal(notifications.inQuietHours(new Date('2026-10-22T17:00:00Z')), true); // 22:30 IST
        assert.equal(notifications.inQuietHours(new Date('2026-10-22T01:00:00Z')), true); // 06:30 IST
        assert.equal(notifications.inQuietHours(new Date('2026-10-22T01:30:00Z')), false); // 07:00 IST
        assert.equal(notifications.inQuietHours(new Date('2026-10-22T06:00:00Z')), false); // 11:30 IST
    });
});

describe('cleanup', () => {
    it('deletes notifications older than NOTIFICATION_RETENTION_DAYS', async () => {
        const alice = await newUser();
        const bob = await newUser();
        await follow(bob, alice);
        await prisma.notification.updateMany({
            where: { recipientId: alice.id },
            data: { createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
        });
        const result = await runAuthCleanup();
        assert.ok(result.notifications >= 1);
        assert.equal((await list(alice)).notifications.length, 0);
    });
});
