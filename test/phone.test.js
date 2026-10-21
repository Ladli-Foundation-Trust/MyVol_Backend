const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { toE164 } = require('../src/utils/phone');
const { api, AUTH, prisma, smsOutbox, resetDb, signup, login, lastSmsCodeFor, bearer } = require('./helpers');

before(resetDb);
after(() => prisma.$disconnect());

// Each test uses its own number, so the per-number cooldown never interferes.
let phoneCounter = 0;
const newPhone = () => {
    phoneCounter += 1;
    return `+9198765${String(phoneCounter).padStart(5, '0')}`;
};

// The per-number cooldown is one code a minute; tests that need a second code skip it.
const skipCooldown = (phone) =>
    prisma.phoneCode.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });

const sendCode = (phone, purpose) => api().post(`${AUTH}/phone/send-code`).send({ phone, purpose });

// send-code + verify-code → { phoneToken, accounts }
const verifyPhone = async (phone, purpose = 'signup') => {
    const sent = await sendCode(phone, purpose);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const res = await api().post(`${AUTH}/phone/verify-code`).send({ phone, otp: lastSmsCodeFor(phone) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
};

let userCounter = 0;
const phoneSignupBody = (phoneToken, overrides = {}) => {
    userCounter += 1;
    return {
        phoneToken,
        name: 'Phone User',
        username: `phoner_${userCounter}`,
        password: 'Sturdy-horse-42',
        dateOfBirth: '2000-01-15',
        acceptTerms: true,
        deviceName: 'Test phone',
        ...overrides,
    };
};

const phoneSignup = async (phone, overrides) => {
    const { phoneToken } = await verifyPhone(phone, 'signup');
    await skipCooldown(phone);
    const body = phoneSignupBody(phoneToken, overrides);
    const res = await api().post(`${AUTH}/phone/signup`).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { body, ...res.body.data };
};

describe('phone number format', () => {
    it('normalises common Indian formats to E.164 and rejects junk', () => {
        for (const raw of ['9876543210', '98765 43210', '+91 98765-43210', '098765 43210', '+919876543210']) {
            assert.equal(toE164(raw), '+919876543210', raw);
        }
        assert.equal(toE164('+14155552671'), '+14155552671');
        for (const raw of ['12345', '1234567890', '+915876543210', 'abc', '+91 98765']) {
            assert.equal(toE164(raw), null, raw);
        }
    });
});

describe('phone signup', () => {
    it('verifies the number first, then creates a phone-only account', async () => {
        const phone = newPhone();
        const { user, accessToken, refreshToken } = await phoneSignup(phone);
        assert.equal(user.phone, phone);
        assert.equal(user.email, null);
        assert.equal(user.hasPassword, true);
        assert.ok(accessToken && refreshToken);

        const me = await api().get(`${AUTH}/me`).set(bearer(accessToken));
        assert.equal(me.body.data.user.phone, phone);
    });

    it('accepts the number in any format and stores it normalised', async () => {
        const sent = await sendCode('98765 99999', 'signup');
        assert.equal(sent.status, 200);
        assert.equal(smsOutbox.at(-1).to, '+919876599999');
    });

    it('rejects a wrong code, and a phoneToken can only be used once', async () => {
        const phone = newPhone();
        await sendCode(phone, 'signup');
        const wrong = await api().post(`${AUTH}/phone/verify-code`).send({ phone, otp: '000000' });
        assert.equal(wrong.status, 400);
        assert.equal(wrong.body.code, 'INVALID_CODE');

        const ok = await api().post(`${AUTH}/phone/verify-code`).send({ phone, otp: lastSmsCodeFor(phone) });
        const { phoneToken } = ok.body.data;
        assert.equal((await api().post(`${AUTH}/phone/signup`).send(phoneSignupBody(phoneToken))).status, 201);

        const again = await api().post(`${AUTH}/phone/signup`).send(phoneSignupBody(phoneToken));
        assert.equal(again.status, 400);
        assert.equal(again.body.code, 'PHONE_TOKEN_INVALID');
    });

    it('keeps the phoneToken usable when signup fails for another reason', async () => {
        const taken = await phoneSignup(newPhone());
        const { phoneToken } = await verifyPhone(newPhone());

        const clash = await api().post(`${AUTH}/phone/signup`).send(phoneSignupBody(phoneToken, { username: taken.body.username }));
        assert.equal(clash.status, 409);
        assert.equal(clash.body.code, 'USERNAME_TAKEN');
        assert.equal((await api().post(`${AUTH}/phone/signup`).send(phoneSignupBody(phoneToken))).status, 201);
    });

    it('rejects a forged or access token as a phoneToken', async () => {
        const { accessToken } = await phoneSignup(newPhone());
        for (const phoneToken of ['not-a-token', accessToken]) {
            const res = await api().post(`${AUTH}/phone/signup`).send(phoneSignupBody(phoneToken));
            assert.equal(res.status, 400);
            assert.equal(res.body.code, 'PHONE_TOKEN_INVALID');
        }
    });

    it('allows at most 4 accounts per number', async () => {
        const phone = newPhone();
        for (let i = 0; i < 4; i++) {
            await phoneSignup(phone);
            await skipCooldown(phone);
        }
        const res = await sendCode(phone, 'signup');
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'PHONE_LIMIT_REACHED');
    });

    it('lists the accounts already on the number when verifying', async () => {
        const phone = newPhone();
        const first = await phoneSignup(phone);
        await skipCooldown(phone);
        const { accounts } = await verifyPhone(phone, 'signup');
        assert.deepEqual(accounts, [{ id: first.user.id, username: first.user.username, name: 'Phone User' }]);
    });
});

describe('phone login', () => {
    it('logs in with phone + password, picking the account whose password matches', async () => {
        const phone = newPhone();
        const a = await phoneSignup(phone, { password: 'First-horse-42' });
        await skipCooldown(phone);
        const b = await phoneSignup(phone, { password: 'Second-horse-42' });

        assert.equal((await login('98765' + phone.slice(-5), 'Second-horse-42')).user.id, b.user.id);
        assert.equal((await login(phone, 'First-horse-42')).user.id, a.user.id);

        const wrong = await api().post(`${AUTH}/login`).send({ identifier: phone, password: 'Nope-horse-42' });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.code, 'INVALID_CREDENTIALS');
    });

    it('logs in with an SMS code and the chosen account', async () => {
        const phone = newPhone();
        await phoneSignup(phone);
        await skipCooldown(phone);
        const second = await phoneSignup(phone);
        await skipCooldown(phone);

        const { phoneToken, accounts } = await verifyPhone(phone, 'login');
        assert.equal(accounts.length, 2);

        const res = await api().post(`${AUTH}/phone/login`).send({ phoneToken, userId: second.user.id, deviceName: 'Phone' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.user.id, second.user.id);
    });

    it('refuses an account that is not on the verified number', async () => {
        const other = await phoneSignup(newPhone());
        const phone = newPhone();
        await phoneSignup(phone);
        await skipCooldown(phone);
        const { phoneToken } = await verifyPhone(phone, 'login');

        const res = await api().post(`${AUTH}/phone/login`).send({ phoneToken, userId: other.user.id });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'ACCOUNT_NOT_ON_PHONE');
    });

    it('does not text numbers without an account, and answers the same way', async () => {
        const phone = newPhone();
        const res = await sendCode(phone, 'login');
        assert.equal(res.status, 200);
        assert.equal(res.body.data, undefined);
        assert.ok(!smsOutbox.some((m) => m.to === phone));
    });
});

describe('phone password reset', () => {
    it('resets the password with an SMS code and signs out every device', async () => {
        const phone = newPhone();
        const { user, accessToken } = await phoneSignup(phone);
        await skipCooldown(phone);
        const { phoneToken } = await verifyPhone(phone, 'login');

        const res = await api()
            .post(`${AUTH}/phone/reset-password`)
            .send({ phoneToken, userId: user.id, newPassword: 'Brand-new-pass-7' });
        assert.equal(res.status, 200, JSON.stringify(res.body));

        assert.equal((await api().get(`${AUTH}/me`).set(bearer(accessToken))).status, 401);
        await login(phone, 'Brand-new-pass-7');
    });
});

describe('add / change phone', () => {
    it('adds a phone to an email account, then the phone works for login', async () => {
        const { accessToken, body } = await signup();
        const phone = newPhone();
        const { phoneToken } = await verifyPhone(phone, 'change');

        const res = await api()
            .post(`${AUTH}/phone/change`)
            .set(bearer(accessToken))
            .send({ phoneToken, password: body.password });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.user.phone, phone);

        await login(phone, body.password);
    });

    it('needs the password', async () => {
        const { accessToken } = await signup();
        const { phoneToken } = await verifyPhone(newPhone(), 'change');
        const res = await api().post(`${AUTH}/phone/change`).set(bearer(accessToken)).send({ phoneToken, password: 'Wrong-pass-1' });
        assert.equal(res.status, 403);
        assert.equal(res.body.code, 'INVALID_PASSWORD');
    });

    it('tells a phone-only user to add an email before verifying one', async () => {
        const { accessToken } = await phoneSignup(newPhone());
        const res = await api().post(`${AUTH}/email/verify/resend`).set(bearer(accessToken));
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'NO_EMAIL');
    });
});
