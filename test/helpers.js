const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const { outbox } = require('../src/lib/mailer');

const api = () => request(app);
const AUTH = '/api/v1/auth';

const resetDb = async () => {
    // Refuse to wipe anything that isn't a *_test database.
    if (!/\/\w+_test\?/.test(process.env.DATABASE_URL)) {
        throw new Error('Tests must run against a *_test database (see .env.test.example)');
    }
    await prisma.$executeRawUnsafe('TRUNCATE users, auth_events CASCADE');
    outbox.length = 0;
};

let counter = 0;
const newUserBody = (overrides = {}) => {
    counter += 1;
    return {
        name: 'Test User',
        email: `person${counter}@example.com`,
        username: `tester_${counter}`,
        password: 'Sturdy-horse-42',
        dateOfBirth: '2000-01-15',
        acceptTerms: true,
        deviceName: 'Test phone',
        ...overrides,
    };
};

const signup = async (overrides) => {
    const body = newUserBody(overrides);
    const res = await api().post(`${AUTH}/signup`).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { body, ...res.body.data };
};

const login = async (identifier, password, deviceName = 'Second device') => {
    const res = await api().post(`${AUTH}/login`).send({ identifier, password, deviceName });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
};

// Codes go to the in-memory outbox in tests; the code is in the subject line.
const lastCodeFor = (email) => {
    const mail = [...outbox].reverse().find((m) => m.to === email && /^\d{6} /.test(m.subject));
    assert.ok(mail, `no code mailed to ${email}`);
    return mail.subject.slice(0, 6);
};

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { api, AUTH, prisma, outbox, resetDb, newUserBody, signup, login, lastCodeFor, bearer };
