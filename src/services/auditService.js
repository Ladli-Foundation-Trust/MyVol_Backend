const prisma = require('../lib/prisma');

const EVENTS = Object.freeze({
    SIGNUP: 'signup',
    LOGIN: 'login',
    LOGIN_FAILED: 'login_failed',
    LOGIN_BLOCKED: 'login_blocked',
    ACCOUNT_LOCKED: 'account_locked',
    LOGOUT: 'logout',
    LOGOUT_ALL: 'logout_all',
    SESSION_REVOKED: 'session_revoked',
    REFRESH_TOKEN_REUSE: 'refresh_token_reuse',
    PASSWORD_CHANGED: 'password_changed',
    PASSWORD_RESET_REQUESTED: 'password_reset_requested',
    PASSWORD_RESET: 'password_reset',
    EMAIL_VERIFIED: 'email_verified',
    EMAIL_CHANGE_REQUESTED: 'email_change_requested',
    EMAIL_CHANGED: 'email_changed',
    GOOGLE_LINKED: 'google_linked',
    ACCOUNT_REACTIVATED: 'account_reactivated',
    ACCOUNT_DEACTIVATED: 'account_deactivated',
    DELETION_SCHEDULED: 'deletion_scheduled',
});

// Fire-and-forget: the audit trail must never block or fail the action it records.
// Call it after the transaction commits so rolled-back actions aren't logged.
const record = (type, { userId, ctx, metadata } = {}) => {
    prisma.authEvent
        .create({
            data: { type, userId, ip: ctx?.ip, userAgent: ctx?.userAgent?.slice(0, 512), metadata },
        })
        .catch((err) => console.error(`[audit] could not record ${type}:`, err.message));
};

module.exports = { EVENTS, record };
