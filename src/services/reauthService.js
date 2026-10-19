const env = require('../config/env');
const AppError = require('../utils/appError');
const { verifyPassword } = require('../utils/password');

// Sensitive actions (email change, deactivate, delete, setting a password) re-check
// identity, so a stolen unlocked phone or access token isn't enough to take the account.
// Users with a password must type it; Google-only users must have signed in recently.
//
// These failures are 403, not 401: on an authenticated route the app treats 401 as
// "session is dead, log out", which would be the wrong reaction to a typo.
const assertReauthenticated = async (user, password, auth) => {
    if (user.passwordHash) {
        const ok = password && (await verifyPassword(user.passwordHash, password));
        if (!ok) throw new AppError('Password is incorrect', 403, undefined, 'INVALID_PASSWORD');
        return;
    }

    const ageMs = Date.now() - new Date(auth.sessionCreatedAt).getTime();
    if (ageMs > env.REAUTH_WINDOW_MINUTES * 60 * 1000) {
        throw new AppError('Please sign in again to continue', 403, undefined, 'REAUTH_REQUIRED');
    }
};

module.exports = { assertReauthenticated };
