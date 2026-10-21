const fs = require('fs');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const storage = require('../src/lib/storage');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const { api, prisma, resetDb, signup, bearer } = require('./helpers');

const USERS = '/api/v1/users';

before(resetDb);
after(() => prisma.$disconnect());

// A signed-in user: { id, username, token, auth: headers }.
const newUser = async (overrides) => {
    const { user, accessToken } = await signup(overrides);
    return { id: user.id, username: user.username, token: accessToken, auth: bearer(accessToken) };
};

const get = (who, url, query) => api().get(`${USERS}${url}`).query(query ?? {}).set(who.auth);
const patch = (who, url, body) => api().patch(`${USERS}${url}`).set(who.auth).send(body);
const followUser = (who, target) => api().post(`${USERS}/${target.username}/follow`).set(who.auth);
const unfollowUser = (who, target) => api().delete(`${USERS}/${target.username}/follow`).set(who.auth);

const counts = async (u) => {
    const row = await prisma.user.findUnique({ where: { id: u.id }, select: { followersCount: true, followingCount: true } });
    return [row.followersCount, row.followingCount];
};

const pngImage = (width = 800, height = 600) =>
    sharp({ create: { width, height, channels: 3, background: '#6754FD' } }).png().toBuffer();

const fileForUrl = (url) => path.join(storage.ROOT, url.split('/uploads/')[1]);

describe('own profile', () => {
    it('starts empty, with zero counts', async () => {
        const me = await newUser();
        const res = await get(me, '/me');
        assert.equal(res.status, 200);
        const { profile } = res.body.data;
        assert.equal(profile.username, me.username);
        assert.equal(profile.isMe, true);
        assert.equal(profile.followersCount, 0);
        assert.equal(profile.pendingRequestsCount, 0);
        assert.equal(profile.avatarUrl, null);
        assert.deepEqual(profile.details.skills, []);
        assert.equal(profile.details.dateOfBirth, '2000-01-15');
    });

    it('updates any mix of fields, and "" clears text', async () => {
        const me = await newUser();
        const res = await patch(me, '/me', {
            bio: '  Weekend volunteer  ',
            city: 'Pune',
            country: 'India',
            gender: 'Female',
            skills: ['Teaching', 'Teaching', 'First aid'],
            availability: ['Weekends'],
            volunteeringTypes: ['Field', 'Online'],
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const { profile } = res.body.data;
        assert.equal(profile.bio, 'Weekend volunteer');
        assert.equal(profile.details.city, 'Pune');
        assert.deepEqual(profile.details.skills, ['Teaching', 'First aid']);

        const cleared = await patch(me, '/me', { bio: '', city: null });
        assert.equal(cleared.body.data.profile.bio, null);
        assert.equal(cleared.body.data.profile.details.city, null);
        assert.equal(cleared.body.data.profile.details.country, 'India');
    });

    it('validates fields', async () => {
        const me = await newUser();
        const cases = [
            [{ bio: 'x'.repeat(151) }, 'bio'],
            [{ gender: 'Robot' }, 'gender'],
            [{ availability: ['Mondays'] }, 'availability.0'],
            [{ role: 'ADMIN' }, ''],
            [{}, ''],
            [{ dateOfBirth: '2020-01-01' }, 'dateOfBirth'],
        ];
        for (const [body, field] of cases) {
            const res = await patch(me, '/me', body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.equal(res.body.details[0].field, field, JSON.stringify(body));
        }
    });
});

describe('username change', () => {
    it('changes once, then waits for the cooldown', async () => {
        const me = await newUser();
        const newName = `renamed_${Date.now().toString(36)}`;
        const res = await patch(me, '/me/username', { username: newName.toUpperCase() });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.profile.username, newName);
        assert.ok(res.body.data.profile.usernameChangeAvailableAt);

        assert.equal((await get(me, `/${me.username}`)).status, 404);
        assert.equal((await get(me, `/${newName}`)).status, 200);

        const again = await patch(me, '/me/username', { username: `${newName}_2` });
        assert.equal(again.status, 429);
        assert.equal(again.body.code, 'USERNAME_CHANGE_TOO_SOON');
    });

    it('rejects taken, reserved and unchanged names', async () => {
        const me = await newUser();
        const other = await newUser();
        assert.equal((await patch(me, '/me/username', { username: other.username })).body.code, 'USERNAME_TAKEN');
        assert.equal((await patch(me, '/me/username', { username: 'admin' })).status, 400);
        assert.equal((await patch(me, '/me/username', { username: me.username })).body.code, 'USERNAME_UNCHANGED');
    });
});

describe('avatar', () => {
    it('stores a 512px WebP, serves it, and replaces the old file', async () => {
        const me = await newUser();
        const res = await api().put(`${USERS}/me/avatar`).set(me.auth).attach('avatar', await pngImage(), 'me.png');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const firstUrl = res.body.data.avatarUrl;
        assert.match(firstUrl, /\/uploads\/avatars\/[0-9a-f-]+\.webp$/);

        const meta = await sharp(fs.readFileSync(fileForUrl(firstUrl))).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);

        const served = await api().get(new URL(firstUrl).pathname);
        assert.equal(served.status, 200);
        assert.equal(served.headers['content-type'], 'image/webp');

        const second = await api().put(`${USERS}/me/avatar`).set(me.auth).attach('avatar', await pngImage(300, 900), 'b.png');
        assert.equal(second.status, 200);
        await new Promise((r) => setTimeout(r, 50)); // old file is deleted in the background
        assert.equal(fs.existsSync(fileForUrl(firstUrl)), false);

        const del = await api().delete(`${USERS}/me/avatar`).set(me.auth);
        assert.equal(del.status, 200);
        assert.equal((await get(me, '/me')).body.data.profile.avatarUrl, null);
    });

    it('rejects non-images, SVG and a missing file', async () => {
        const me = await newUser();
        const text = await api().put(`${USERS}/me/avatar`).set(me.auth).attach('avatar', Buffer.from('hello'), 'x.png');
        assert.equal(text.body.code, 'INVALID_IMAGE');

        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
        assert.equal((await api().put(`${USERS}/me/avatar`).set(me.auth).attach('avatar', svg, 'x.svg')).body.code, 'INVALID_IMAGE');

        assert.equal((await api().put(`${USERS}/me/avatar`).set(me.auth)).body.code, 'FILE_REQUIRED');
    });
});

describe('public profiles', () => {
    it('are found by username or id, and hide inactive users', async () => {
        const viewer = await newUser();
        const target = await newUser();
        const byName = await get(viewer, `/${target.username}`);
        assert.equal(byName.status, 200);
        assert.equal(byName.body.data.profile.isMe, false);
        assert.equal(byName.body.data.profile.followStatus, 'none');
        assert.equal((await get(viewer, `/${target.id}`)).body.data.profile.id, target.id);

        await prisma.user.update({ where: { id: target.id }, data: { status: 'DEACTIVATED' } });
        const gone = await get(viewer, `/${target.username}`);
        assert.equal(gone.status, 404);
        assert.equal(gone.body.code, 'USER_NOT_FOUND');
    });

    it('show personal details only when the owner allows it', async () => {
        const viewer = await newUser();
        const owner = await newUser();
        await patch(owner, '/me', { gender: 'Male', skills: ['Cooking'] });

        let { details } = (await get(viewer, `/${owner.username}`)).body.data.profile;
        assert.deepEqual(details.skills, ['Cooking']);
        assert.equal('gender' in details, false);
        assert.equal('dateOfBirth' in details, false);

        await patch(owner, '/me', { showPersonalDetails: true });
        ({ details } = (await get(viewer, `/${owner.username}`)).body.data.profile);
        assert.equal(details.gender, 'Male');
    });
});

describe('follow (public accounts)', () => {
    it('follows at once, keeps counts right on repeats, and unfollows', async () => {
        const a = await newUser();
        const b = await newUser();

        const res = await followUser(a, b);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.followStatus, 'following');
        await followUser(a, b); // repeat: no double count
        assert.deepEqual(await counts(a), [0, 1]);
        assert.deepEqual(await counts(b), [1, 0]);

        const seenByB = (await get(b, `/${a.username}`)).body.data.profile;
        assert.equal(seenByB.followsYou, true);

        assert.equal((await unfollowUser(a, b)).body.data.followStatus, 'none');
        await unfollowUser(a, b);
        assert.deepEqual(await counts(a), [0, 0]);
        assert.deepEqual(await counts(b), [0, 0]);
    });

    it("can't follow yourself", async () => {
        const a = await newUser();
        const res = await followUser(a, a);
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'CANNOT_FOLLOW_SELF');
    });

    it('lists followers/following newest first, paginated without repeats', async () => {
        const star = await newUser();
        const fans = [];
        for (let i = 0; i < 5; i++) {
            const fan = await newUser();
            await followUser(fan, star);
            fans.push(fan);
        }
        await prisma.user.update({ where: { id: fans[0].id }, data: { status: 'SUSPENDED' } });

        const seen = [];
        let cursor;
        do {
            const res = await get(fans[1], `/${star.username}/followers`, { limit: 2, ...(cursor && { cursor }) });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            seen.push(...res.body.data.users.map((u) => u.username));
            cursor = res.body.data.nextCursor;
        } while (cursor);

        // newest first, suspended fan hidden, the viewer marked as isMe
        assert.deepEqual(seen, fans.slice(1).reverse().map((f) => f.username));

        const following = await get(star, `/${fans[2].username}/following`);
        assert.equal(following.body.data.users[0].id, star.id);
        assert.equal(following.body.data.users[0].isMe, true);

        assert.equal((await get(star, `/${star.username}/followers`, { cursor: 'garbage' })).body.code, 'INVALID_CURSOR');
    });

    it('lets you remove a follower', async () => {
        const a = await newUser();
        const b = await newUser();
        await followUser(a, b);
        const res = await api().delete(`${USERS}/${a.username}/follower`).set(b.auth);
        assert.equal(res.status, 200);
        assert.deepEqual(await counts(b), [0, 0]);
        assert.deepEqual(await counts(a), [0, 0]);
    });
});

describe('private accounts', () => {
    it('turn follows into requests and hide details and lists until accepted', async () => {
        const owner = await newUser();
        const fan = await newUser();
        await patch(owner, '/me', { isPrivate: true, skills: ['Secret'] });

        assert.equal((await followUser(fan, owner)).body.data.followStatus, 'requested');
        assert.deepEqual(await counts(owner), [0, 0]);

        const seen = (await get(fan, `/${owner.username}`)).body.data.profile;
        assert.equal(seen.followStatus, 'requested');
        assert.equal(seen.canViewContent, false);
        assert.equal(seen.details, null);
        assert.equal(seen.bio, null); // name, bio, avatar and counts stay visible, like Instagram
        const list = await get(fan, `/${owner.username}/followers`);
        assert.equal(list.status, 403);
        assert.equal(list.body.code, 'PRIVATE_ACCOUNT');

        const requests = await get(owner, '/me/follow-requests');
        assert.equal(requests.body.data.requests[0].user.id, fan.id);
        assert.equal((await get(owner, '/me')).body.data.profile.pendingRequestsCount, 1);

        const accept = await api().post(`${USERS}/me/follow-requests/${fan.id}/accept`).set(owner.auth);
        assert.equal(accept.status, 200);
        assert.deepEqual(await counts(owner), [1, 0]);

        const after = (await get(fan, `/${owner.username}`)).body.data.profile;
        assert.equal(after.followStatus, 'following');
        assert.deepEqual(after.details.skills, ['Secret']);

        const again = await api().post(`${USERS}/me/follow-requests/${fan.id}/accept`).set(owner.auth);
        assert.equal(again.body.code, 'REQUEST_NOT_FOUND');
    });

    it('can decline a request, and the requester can cancel one', async () => {
        const owner = await newUser();
        const a = await newUser();
        const b = await newUser();
        await patch(owner, '/me', { isPrivate: true });
        await followUser(a, owner);
        await followUser(b, owner);

        assert.equal((await api().delete(`${USERS}/me/follow-requests/${a.id}`).set(owner.auth)).status, 200);
        await unfollowUser(b, owner); // cancels b's request
        assert.deepEqual((await get(owner, '/me/follow-requests')).body.data.requests, []);
    });

    it('approve everyone waiting when the account goes public', async () => {
        const owner = await newUser();
        const a = await newUser();
        const b = await newUser();
        await patch(owner, '/me', { isPrivate: true });
        await followUser(a, owner);
        await followUser(b, owner);

        const res = await patch(owner, '/me', { isPrivate: false });
        assert.equal(res.body.data.profile.followersCount, 2);
        assert.equal(res.body.data.profile.pendingRequestsCount, 0);
        assert.deepEqual(await counts(a), [0, 1]);
    });
});

describe('account purge', () => {
    it("takes a deleted user's follows off other people's counts and deletes their avatar", async () => {
        const leaver = await newUser();
        const friend = await newUser();
        await followUser(leaver, friend);
        await followUser(friend, leaver);
        const upload = await api().put(`${USERS}/me/avatar`).set(leaver.auth).attach('avatar', await pngImage(), 'a.png');
        const avatarFile = fileForUrl(upload.body.data.avatarUrl);

        await prisma.user.update({
            where: { id: leaver.id },
            data: { status: 'PENDING_DELETION', deletionScheduledAt: new Date(Date.now() - 1000) },
        });
        await runAuthCleanup();
        assert.deepEqual(await counts(friend), [0, 0]);
        assert.equal(fs.existsSync(avatarFile), false);
    });
});
