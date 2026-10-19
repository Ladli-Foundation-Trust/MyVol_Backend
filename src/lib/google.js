const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const AppError = require('../utils/appError');

const client = new OAuth2Client();

// Checks the ID token's signature (Google's public keys), expiry, issuer and that it
// was minted for one of our client IDs. Never trust profile data sent by the app itself.
const verifyIdToken = async (idToken) => {
    if (env.googleClientIds.length === 0) {
        throw new AppError('Google sign-in is not available', 503, undefined, 'GOOGLE_NOT_CONFIGURED');
    }

    let payload;
    try {
        const ticket = await client.verifyIdToken({ idToken, audience: env.googleClientIds });
        payload = ticket.getPayload();
    } catch {
        throw new AppError('Google sign-in failed. Please try again', 401, undefined, 'GOOGLE_TOKEN_INVALID');
    }

    return {
        sub: payload.sub,
        email: payload.email?.toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: payload.name,
    };
};

// Exported as an object (not destructured by callers) so tests can stub it.
module.exports = { verifyIdToken };
