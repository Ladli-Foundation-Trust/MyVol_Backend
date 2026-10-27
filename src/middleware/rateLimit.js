const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const AppError = require('../utils/appError');

// In-memory counters: fine for one instance, reset on restart. Add a Redis store
// (rate-limit-redis) before running more than one instance.
//
// Per-IP limits are generous because many Indian mobile users share one public IP
// (carrier-grade NAT). Per-account protection comes from login lockout and the code
// attempt caps in the services, not from these.
const limiter = ({ windowMinutes, limit, message, byUser = false, ...rest }) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skip: () => env.isTest,
        // Per-user limiters run after `protect`, so req.user is set.
        keyGenerator: (req) => (byUser && req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
        handler: (req, res, next) => next(new AppError(message, 429, undefined, 'RATE_LIMITED')),
        ...rest,
    });

const apiLimiter = limiter({
    windowMinutes: 15,
    limit: 1000,
    message: 'Too many requests. Please slow down',
});

// Counts only failed attempts, so a busy shared IP isn't blocked by normal logins.
const loginLimiter = limiter({
    windowMinutes: 15,
    limit: 20,
    skipSuccessfulRequests: true,
    message: 'Too many login attempts. Please try again in 15 minutes',
});

const signupLimiter = limiter({
    windowMinutes: 60,
    limit: 10,
    message: 'Too many accounts created from this network. Please try again later',
});

const refreshLimiter = limiter({
    windowMinutes: 15,
    limit: 100,
    message: 'Too many requests. Please try again shortly',
});

const passwordResetLimiter = limiter({
    windowMinutes: 15,
    limit: 10,
    message: 'Too many password reset requests. Please try again in 15 minutes',
});

// Every SMS costs money, and "SMS pumping" fraud abuses send-code endpoints to text
// premium numbers. Per-number caps live in phoneCodeService; this caps one network.
const smsLimiter = limiter({
    windowMinutes: 15,
    limit: 20,
    message: 'Too many codes requested from this network. Please try again in 15 minutes',
});

const usernameCheckLimiter = limiter({
    windowMinutes: 1,
    limit: 60,
    message: 'Too many requests. Please slow down',
});

// Code entry/resend and password-confirmed actions, per signed-in user. Stops a stolen
// access token being used to guess the password through the re-auth prompts.
const accountActionLimiter = limiter({
    windowMinutes: 15,
    limit: 10,
    byUser: true,
    message: 'Too many attempts. Please try again in 15 minutes',
});

// Per signed-in user. Mass follow/unfollow is the classic bot pattern.
const followLimiter = limiter({
    windowMinutes: 15,
    limit: 100,
    byUser: true,
    message: 'You are following and unfollowing too fast. Please try again later',
});

const uploadLimiter = limiter({
    windowMinutes: 60,
    limit: 20,
    byUser: true,
    message: 'Too many uploads. Please try again later',
});

const postLimiter = limiter({
    windowMinutes: 60,
    limit: 30,
    byUser: true,
    message: 'You are posting too fast. Please try again later',
});

const commentLimiter = limiter({
    windowMinutes: 15,
    limit: 60,
    byUser: true,
    message: 'You are commenting too fast. Please try again later',
});

// Likes, saves, shares: generous, but stops scripts hammering counters.
const engagementLimiter = limiter({
    windowMinutes: 15,
    limit: 300,
    byUser: true,
    message: 'Too many actions. Please slow down',
});

// "Send me a test notification" (a developer tool).
const testNotificationLimiter = limiter({
    windowMinutes: 15,
    limit: 30,
    byUser: true,
    message: 'Too many test notifications. Please try again in 15 minutes',
});

// Search runs on every keystroke (debounced by the app); per user.
const searchLimiter = limiter({
    windowMinutes: 1,
    limit: 90,
    byUser: true,
    message: 'Too many searches. Please slow down',
});

// Reports: plenty for real use, stops report-bombing scripts.
const reportLimiter = limiter({
    windowMinutes: 60,
    limit: 30,
    byUser: true,
    message: 'Too many reports. Please try again later',
});

const storyLimiter = limiter({
    windowMinutes: 60,
    limit: 30,
    byUser: true,
    message: 'You are sharing stories too fast. Please try again later',
});

// Data export builds a large file; a few per hour is plenty.
const exportLimiter = limiter({
    windowMinutes: 60,
    limit: 5,
    byUser: true,
    message: 'Too many downloads. Please try again later',
});

module.exports = {
    storyLimiter,
    exportLimiter,
    searchLimiter,
    reportLimiter,
    testNotificationLimiter,
    apiLimiter,
    loginLimiter,
    signupLimiter,
    refreshLimiter,
    passwordResetLimiter,
    smsLimiter,
    usernameCheckLimiter,
    accountActionLimiter,
    followLimiter,
    uploadLimiter,
    postLimiter,
    commentLimiter,
    engagementLimiter,
};
