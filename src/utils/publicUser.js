const storage = require('../lib/storage');

// The client hides password_hash by default (src/lib/prisma.js). Auth queries spread
// this in so toPublicUser can report `hasPassword` without ever returning the hash.
const WITH_PASSWORD = { omit: { passwordHash: false } };

// The signed-in user's own view of their account. Never used for other people's profiles.
const toPublicUser = (u) => ({
    id: u.id,
    email: u.email, // null for phone-only accounts
    phone: u.phone, // E.164 or null; a phone on an account is always verified
    username: u.username,
    name: u.name,
    avatarUrl: storage.urlFor(u.avatarKey),
    role: u.role,
    emailVerified: Boolean(u.emailVerifiedAt),
    hasPassword: Boolean(u.passwordHash),
    dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().slice(0, 10) : null,
    createdAt: u.createdAt,
});

module.exports = { WITH_PASSWORD, toPublicUser };
