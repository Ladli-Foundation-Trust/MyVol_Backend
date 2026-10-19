const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'myvolapp-api', audience: 'myvolapp-app' };

// `sid` ties the access token to a session row, so revoking the session
// (logout, "log out this device", password change) cuts it off immediately.
const signAccessToken = (user, sessionId) => {
    const accessToken = jwt.sign({ role: user.role, sid: sessionId }, env.JWT_ACCESS_SECRET, {
        ...JWT_OPTIONS,
        subject: user.id,
        expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    });
    const { exp } = jwt.decode(accessToken);
    return { accessToken, accessTokenExpiresAt: new Date(exp * 1000) };
};

const verifyAccessToken = (token) =>
    jwt.verify(token, env.JWT_ACCESS_SECRET, { ...JWT_OPTIONS, algorithms: ['HS256'] });

const generateRefreshToken = () => crypto.randomBytes(48).toString('base64url');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const generateOtp = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

// The scope (purpose + user id) is mixed in, so a code is only valid for the
// account and the action it was issued for.
const hashOtp = (code, scope) =>
    crypto.createHmac('sha256', env.OTP_SECRET).update(`${scope}:${code}`).digest('hex');

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
