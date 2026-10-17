const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'myvolapp-api', audience: 'myvolapp-app' };

const signAccessToken = (user) =>
    jwt.sign({ role: user.role, ver: user.tokenVersion }, env.JWT_ACCESS_SECRET, {
        ...JWT_OPTIONS,
        subject: user.id,
        expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    });

const verifyAccessToken = (token) =>
    jwt.verify(token, env.JWT_ACCESS_SECRET, { ...JWT_OPTIONS, algorithms: ['HS256'] });


const generateRefreshToken = () => crypto.randomBytes(48).toString('base64url');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const generateOtp = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

const hashOtp = (code) => crypto.createHmac('sha256', env.OTP_SECRET).update(code).digest('hex');

const safeEqual = (a, b) => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

module.exports = {
    signAccessToken,
    verifyAccessToken,
    generateRefreshToken,
    sha256,
    generateOtp,
    hashOtp,
    safeEqual,
};
