const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const google = require('../src/lib/google');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const { api, AUTH, prisma, outbox, resetDb, newUserBody, signup, login, lastCodeFor, bearer } = require('./helpers');

before(resetDb);
after(() => prisma.$disconnect());

describe('signup', () => {
    it('creates an unverified user, a session, and mails a verification code', async () => {
        const { user, accessToken, refreshToken, body } = await signup();
        assert.equal(user.email, body.email);
        assert.equal(user.emailVerified, false);
        assert.equal(user.hasPassword, true);
        assert.equal(user.dateOfBirth, '2000-01-15');
        assert.ok(accessToken && refreshToken);
        assert.match(lastCodeFor(body.email), /^\d{6}$/);
    });

    it('rejects a duplicate email with EMAIL_TAKEN', async () => {
        const { body } = await signup();
        const res = await api().post(`${AUTH}/signup`).send(newUserBody({ email: body.email }));
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'EMAIL_TAKEN');
    });

    it('enforces the age gate, reserved names, common and personal passwords, and terms', async () => {
        const cases = [
            [{ dateOfBirth: new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10) }, 'dateOfBirth'],
            [{ username: 'admin' }, 'username'],
            [{ username: 'sup.port' }, 'username'],
            [{ password: 'password123' }, 'password'],
            [{ username: 'skywalker', password: 'skywalker99' }, 'password'],
            [{ acceptTerms: false }, 'acceptTerms'],
        ];
        for (const [overrides, field] of cases) {
            const res = await api().post(`${AUTH}/signup`).send(newUserBody(overrides));
            assert.equal(res.status, 400, JSON.stringify(overrides));
            assert.equal(res.body.details[0].field, field);
        }
    });
});

describe('login', () => {
    it('accepts email or username', async () => {
        const { body } = await signup();
        await login(body.email, body.password);
        await login(body.username.toUpperCase(), body.password);
    });

    it('locks the account after 5 failures, even for the right password', async () => {
        const { body } = await signup();
        for (let i = 0; i < 5; i++) {
            const res = await api().post(`${AUTH}/login`).send({ identifier: body.email, password: 'wrong-pass-1' });
            assert.equal(res.status, 401);
            assert.equal(res.body.code, 'INVALID_CREDENTIALS');
        }
        const res = await api().post(`${AUTH}/login`).send({ identifier: body.email, password: body.password });
        assert.equal(res.status, 429);
        assert.equal(res.body.code, 'ACCOUNT_LOCKED');
    });

    it('gives unknown users the same error as wrong passwords', async () => {
        const res = await api().post(`${AUTH}/login`).send({ identifier: 'nobody@example.com', password: 'x' });
        assert.equal(res.status, 401);
        assert.equal(res.body.code, 'INVALID_CREDENTIALS');
    });

    it('blocks suspended accounts only after the right password', async () => {
        const { body, user } = await signup();
        await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
        const wrong = await api().post(`${AUTH}/login`).send({ identifier: body.email, password: 'wrong-pass-1' });
        assert.equal(wrong.status, 401);
        const right = await api().post(`${AUTH}/login`).send({ identifier: body.email, password: body.password });
        assert.equal(right.status, 403);
        assert.equal(right.body.code, 'ACCOUNT_SUSPENDED');
    });
});

describe('protected routes', () => {
    it('require a bearer token', async () => {
        const res = await api().get(`${AUTH}/me`);
        assert.equal(res.status, 401);
        assert.equal(res.body.code, 'NOT_AUTHENTICATED');
    });

    it('return the current user and are never cached', async () => {
        const { accessToken, user } = await signup();
        const res = await api().get(`${AUTH}/me`).set(bearer(accessToken));
        assert.equal(res.status, 200);
        assert.equal(res.body.data.user.id, user.id);
        assert.equal(res.headers['cache-control'], 'no-store');
    });

    it('still 404 on unknown auth paths', async () => {
        const res = await api().get(`${AUTH}/does-not-exist`);
        assert.equal(res.status, 404);
    });

    it('cut off a suspended user immediately', async () => {
        const { accessToken, user } = await signup();
        await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
        const res = await api().get(`${AUTH}/me`).set(bearer(accessToken));
        assert.equal(res.status, 401);
        assert.equal(res.body.code, 'ACCOUNT_INACTIVE');
    });
});

describe('email verification', () => {
    it('rejects a wrong code, accepts the right one', async () => {
        const { body, accessToken } = await signup();
        const wrongCode = lastCodeFor(body.email) === '000000' ? '111111' : '000000';
        const wrong = await api().post(`${AUTH}/email/verify`).set(bearer(accessToken)).send({ otp: wrongCode });
        assert.equal(wrong.status, 400);
        assert.equal(wrong.body.code, 'INVALID_CODE');

        const ok = await api().post(`${AUTH}/email/verify`).set(bearer(accessToken)).send({ otp: lastCodeFor(body.email) });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.data.user.emailVerified, true);

        const resend = await api().post(`${AUTH}/email/verify/resend`).set(bearer(accessToken));
        assert.equal(resend.status, 400);
        assert.equal(resend.body.code, 'EMAIL_ALREADY_VERIFIED');
    });

    it('enforces a resend cooldown', async () => {
        const { accessToken } = await signup();
        const res = await api().post(`${AUTH}/email/verify/resend`).set(bearer(accessToken));
        assert.equal(res.status, 429);
        assert.equal(res.body.code, 'CODE_COOLDOWN');
    });

    it('kills a code after 5 wrong guesses', async () => {
        const { body, accessToken } = await signup();
        const code = lastCodeFor(body.email);
        const wrongCode = code === '123456' ? '654321' : '123456';
        for (let i = 0; i < 5; i++) {
            await api().post(`${AUTH}/email/verify`).set(bearer(accessToken)).send({ otp: wrongCode });
        }
        const res = await api().post(`${AUTH}/email/verify`).set(bearer(accessToken)).send({ otp: code });
        assert.equal(res.status, 400);
    });
});

describe('refresh tokens', () => {
    it('rotate, and a replayed token revokes the whole session', async () => {
        const { refreshToken, accessToken } = await signup();

        const first = await api().post(`${AUTH}/refresh`).send({ refreshToken });
        assert.equal(first.status, 200);
        const next = first.body.data;
        assert.notEqual(next.refreshToken, refreshToken);

        const replay = await api().post(`${AUTH}/refresh`).send({ refreshToken });
        assert.equal(replay.status, 401);

        // The legitimate holder is cut off as well: the session is gone.
        const after = await api().post(`${AUTH}/refresh`).send({ refreshToken: next.refreshToken });
        assert.equal(after.status, 401);
        const me = await api().get(`${AUTH}/me`).set(bearer(accessToken));
        assert.equal(me.status, 401);
        assert.equal(me.body.code, 'SESSION_INVALID');
    });

    it('also work from the httpOnly cookie', async () => {
        const res = await api().post(`${AUTH}/signup`).send(newUserBody());
        const cookie = res.headers['set-cookie'][0];
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        const refreshed = await api().post(`${AUTH}/refresh`).set('Cookie', cookie.split(';')[0]);
        assert.equal(refreshed.status, 200);
    });

    it('logout revokes the session and its access token', async () => {
        const { refreshToken, accessToken } = await signup();
        const res = await api().post(`${AUTH}/logout`).send({ refreshToken });
        assert.equal(res.status, 200);
        const me = await api().get(`${AUTH}/me`).set(bearer(accessToken));
        assert.equal(me.status, 401);
    });
});

describe('sessions', () => {
    it('lists devices and can log one out', async () => {
        const { body, accessToken } = await signup();
        const other = await login(body.email, body.password, 'Tablet');

        const list = await api().get(`${AUTH}/sessions`).set(bearer(accessToken));
        assert.equal(list.body.data.sessions.length, 2);
        const tablet = list.body.data.sessions.find((s) => s.deviceName === 'Tablet');
        assert.equal(tablet.current, false);
        assert.equal(list.body.data.sessions.filter((s) => s.current).length, 1);

        const del = await api().delete(`${AUTH}/sessions/${tablet.id}`).set(bearer(accessToken));
        assert.equal(del.status, 200);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(other.accessToken))).status, 401);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(accessToken))).status, 200);

        const again = await api().delete(`${AUTH}/sessions/${tablet.id}`).set(bearer(accessToken));
        assert.equal(again.status, 404);
    });

    it('logout-all ends every session', async () => {
        const { body, accessToken } = await signup();
        const other = await login(body.email, body.password);
        await api().post(`${AUTH}/logout-all`).set(bearer(accessToken)).expect(200);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(accessToken))).status, 401);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(other.accessToken))).status, 401);
    });
});

describe('passwords', () => {
    it('change: needs the current password, keeps this device, signs out the others', async () => {
        const { body, accessToken } = await signup();
        const other = await login(body.email, body.password);

        const wrong = await api()
            .patch(`${AUTH}/change-password`)
            .set(bearer(accessToken))
            .send({ currentPassword: 'not-it-123', newPassword: 'Brand-new-pass-7' });
        assert.equal(wrong.status, 403);
        assert.equal(wrong.body.code, 'INVALID_PASSWORD');

        const ok = await api()
            .patch(`${AUTH}/change-password`)
            .set(bearer(accessToken))
            .send({ currentPassword: body.password, newPassword: 'Brand-new-pass-7' });
        assert.equal(ok.status, 200);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(accessToken))).status, 200);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(other.accessToken))).status, 401);
        await login(body.email, 'Brand-new-pass-7');
    });

    it('reset: same answer for unknown emails, code works once, clears lockout, verifies email', async () => {
        const unknown = await api().post(`${AUTH}/forgot-password`).send({ email: 'ghost@example.com' });
        const { body, accessToken, user } = await signup();
        await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + 3600e3) } });

        const known = await api().post(`${AUTH}/forgot-password`).send({ email: body.email });
        assert.equal(known.status, 200);
        assert.deepEqual(known.body, unknown.body);

        const otp = lastCodeFor(body.email);
        const reset = { email: body.email, otp, newPassword: 'Reset-pass-2024' };
        assert.equal((await api().post(`${AUTH}/reset-password`).send(reset)).status, 200);
        assert.equal((await api().post(`${AUTH}/reset-password`).send(reset)).status, 400);

        assert.equal((await api().get(`${AUTH}/me`).set(bearer(accessToken))).status, 401);
        const session = await login(body.email, 'Reset-pass-2024');
        assert.equal(session.user.emailVerified, true);
    });
});

describe('email change', () => {
    it('confirms through the new inbox and tells the old one', async () => {
        const { body, accessToken } = await signup();
        const newEmail = `moved-${Date.now()}@example.com`;

        const noPassword = await api().post(`${AUTH}/email/change`).set(bearer(accessToken)).send({ newEmail });
        assert.equal(noPassword.status, 403);

        await api()
            .post(`${AUTH}/email/change`)
            .set(bearer(accessToken))
            .send({ newEmail, password: body.password })
            .expect(200);

        const res = await api()
            .post(`${AUTH}/email/change/confirm`)
            .set(bearer(accessToken))
            .send({ otp: lastCodeFor(newEmail) });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.user.email, newEmail);
        assert.ok(outbox.some((m) => m.to === body.email && /email was changed/.test(m.subject)));
        await login(newEmail, body.password);
    });
});

describe('account lifecycle', () => {
    it('deactivate signs out; logging in reactivates', async () => {
        const { body, accessToken } = await signup();
        await api().post(`${AUTH}/account/deactivate`).set(bearer(accessToken)).send({ password: body.password }).expect(200);
        assert.equal((await api().get(`${AUTH}/me`).set(bearer(accessToken))).status, 401);

        const session = await login(body.email, body.password);
        assert.equal(session.reactivated, true);
    });

    it('delete schedules a purge that the cleanup job carries out', async () => {
        const { body, accessToken, user } = await signup();
        const res = await api().post(`${AUTH}/account/delete`).set(bearer(accessToken)).send({ password: body.password });
        assert.equal(res.status, 200);
        assert.ok(res.body.data.deletionScheduledAt);

        await prisma.user.update({ where: { id: user.id }, data: { deletionScheduledAt: new Date(Date.now() - 1000) } });
        const result = await runAuthCleanup();
        assert.ok(result.purgedUsers >= 1);
        assert.equal(await prisma.user.findUnique({ where: { id: user.id } }), null);
    });
});

describe('username availability', () => {
    it('reports taken, free and reserved names', async () => {
        const { body } = await signup();
        const check = (u) => api().get(`${AUTH}/username-available`).query({ username: u });
        assert.equal((await check(body.username)).body.data.available, false);
        assert.equal((await check('free_name_123')).body.data.available, true);
        assert.equal((await check('admin')).status, 400);
    });
});

describe('google sign-in', () => {
    const realVerify = google.verifyIdToken;
    let profile;
    before(() => {
        google.verifyIdToken = async () => profile;
    });
    after(() => {
        google.verifyIdToken = realVerify;
    });

    it('asks a new user for the missing details, then creates a verified account', async () => {
        profile = { sub: 'g-new-1', email: 'priya.sharma@gmail.com', emailVerified: true, name: 'Priya Sharma' };

        const first = await api().post(`${AUTH}/google`).send({ idToken: 't' });
        assert.equal(first.status, 400);
        assert.equal(first.body.code, 'PROFILE_REQUIRED');
        assert.deepEqual(first.body.details.map((d) => d.field), ['dateOfBirth', 'acceptTerms']);

        const created = await api().post(`${AUTH}/google`).send({ idToken: 't', dateOfBirth: '1999-05-01', acceptTerms: true });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.isNewUser, true);
        assert.equal(created.body.data.user.username, 'priya.sharma');
        assert.equal(created.body.data.user.emailVerified, true);
        assert.equal(created.body.data.user.hasPassword, false);

        const again = await api().post(`${AUTH}/google`).send({ idToken: 't' });
        assert.equal(again.status, 200);
        assert.equal(again.body.data.isNewUser, false);
    });

    it('lets a Google-only user set a password without a current one, right after signing in', async () => {
        profile = { sub: 'g-new-2', email: 'aarav@gmail.com', emailVerified: true, name: 'Aarav' };
        const res = await api().post(`${AUTH}/google`).send({ idToken: 't', dateOfBirth: '1998-02-02', acceptTerms: true });
        const set = await api()
            .patch(`${AUTH}/change-password`)
            .set(bearer(res.body.data.accessToken))
            .send({ newPassword: 'First-pass-99' });
        assert.equal(set.status, 200);
        assert.equal(set.body.data.user.hasPassword, true);
    });

    it('takes back an unverified account someone pre-registered with the victim\'s email', async () => {
        const squatter = await signup({ email: 'victim@gmail.com' });
        profile = { sub: 'g-victim', email: 'victim@gmail.com', emailVerified: true, name: 'Victim' };

        const res = await api().post(`${AUTH}/google`).send({ idToken: 't' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.user.id, squatter.user.id);
        assert.equal(res.body.data.user.hasPassword, false);

        assert.equal((await api().get(`${AUTH}/me`).set(bearer(squatter.accessToken))).status, 401);
        const pw = await api().post(`${AUTH}/login`).send({ identifier: 'victim@gmail.com', password: squatter.body.password });
        assert.equal(pw.status, 401);
    });

    it('rejects Google accounts whose email is unverified', async () => {
        profile = { sub: 'g-unverified', email: 'x@gmail.com', emailVerified: false };
        const res = await api().post(`${AUTH}/google`).send({ idToken: 't' });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'GOOGLE_EMAIL_UNVERIFIED');
    });
});

describe('audit log', () => {
    it('records security events', async () => {
        const types = new Set((await prisma.authEvent.findMany({ select: { type: true } })).map((e) => e.type));
        for (const t of ['signup', 'login', 'login_failed', 'account_locked', 'refresh_token_reuse', 'password_reset']) {
            assert.ok(types.has(t), `missing ${t}`);
        }
    });
});
