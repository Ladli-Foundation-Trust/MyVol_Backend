const { rateLimit } = require('express-rate-limit');
const AppError = require('../utils/appError');


const limiter = ({ windowMinutes, limit, message }) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res, next) => next(new AppError(message, 429)),
    });

const loginLimiter = limiter({
    windowMinutes: 15,
    limit: 10,
    message: 'Too many login attempts. Please try again in 15 minutes',
});

const signupLimiter = limiter({
    windowMinutes: 60,
    limit: 10,
    message: 'Too many accounts created from this network. Please try again later',
});

const passwordResetLimiter = limiter({
    windowMinutes: 15,
    limit: 5,
    message: 'Too many password reset requests. Please try again in 15 minutes',
});

module.exports = { loginLimiter, signupLimiter, passwordResetLimiter };
