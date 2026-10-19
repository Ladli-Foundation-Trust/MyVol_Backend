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

module.exports = {
    apiLimiter,
    loginLimiter,
    signupLimiter,
    refreshLimiter,
    passwordResetLimiter,
    usernameCheckLimiter,
    accountActionLimiter,
};
