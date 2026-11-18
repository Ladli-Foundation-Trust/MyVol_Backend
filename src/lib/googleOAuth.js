const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const google = require('./google');
const AppError = require('../utils/appError');
const sealed = require('../utils/sealed');

// Google sign-in through the browser (decision.md D80), for an app with no native
// Google SDK:
//
//   app  ── opens ──▶ GET /auth/google/start?redirectUri&codeChallenge
//        ◀── 302 ──  accounts.google.com (state + nonce)
//   Google ── 302 ──▶ GET /auth/callback/google?code&state      (the URI registered in Google Cloud)
//        server swaps the code for an ID token (client secret), verifies it, then
//        ── 302 ──▶ myvolapp://oauth/google?code=<sealed ticket>
//   app  ── POST /auth/google { googleCode, codeVerifier } ──▶ session
//
// The ticket is sealed (utils/sealed) and bound to the app's PKCE challenge, so a
// ticket caught on its way through the custom scheme is useless without the verifier
// that never left the app. It lives long enough for a new user to fill in their birth
// date and accept the terms (PROFILE_REQUIRED → same ticket again).

const STATE_TTL_SECONDS = 10 * 60;
const TICKET_TTL_SECONDS = 10 * 60;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const assertConfigured = () => {
    if (!env.googleWebOAuth) {
        throw new AppError('Google sign-in is not available', 503, undefined, 'GOOGLE_NOT_CONFIGURED');
    }
};

const isAllowedAppRedirect = (uri) => env.googleAppRedirectUris.includes(uri);

const challengeOf = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

const withParams = (uri, params) => `${uri}${uri.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;

// Step 1: the Google consent URL. Validation (allowed redirect, challenge shape) is done
// by the route's schema and here.
const buildAuthUrl = ({ redirectUri, codeChallenge }) => {
    assertConfigured();
    if (!isAllowedAppRedirect(redirectUri)) {
        throw new AppError('redirectUri is not allowed', 400, undefined, 'REDIRECT_NOT_ALLOWED');
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = sealed.seal('google-state', { r: redirectUri, c: codeChallenge, n: nonce }, STATE_TTL_SECONDS);
    return withParams(AUTH_URL, {
        client_id: env.GOOGLE_WEB_CLIENT_ID,
        redirect_uri: env.googleRedirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        prompt: 'select_account',
    });
};

// Swaps Google's one-time code for tokens. On the module object so tests can stub it.
const exchangeCode = async (code) => {
    const client = new OAuth2Client(env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_WEB_CLIENT_SECRET, env.googleRedirectUri);
    const { tokens } = await client.getToken(code);
    return tokens.id_token;
};

// Step 2: Google's redirect. Always answers with a URL to send the browser to: the app
// on success or failure (with ?error=…), or null when the state is unreadable and we
// don't know which app asked (the route then shows a plain error page).
const handleCallback = async ({ code, state, error }) => {
    const st = sealed.open('google-state', state);
    if (!st || !isAllowedAppRedirect(st.r)) return null;
    const back = (params) => withParams(st.r, params);

    if (error) return back({ error: error === 'access_denied' ? 'cancelled' : 'google_error' });
    if (!code) return back({ error: 'google_error' });

    try {
        const idToken = await module.exports.exchangeCode(code);
        const profile = await google.verifyIdToken(idToken);
        if (profile.nonce !== st.n) return back({ error: 'google_error' });
        const ticket = sealed.seal(
            'google-ticket',
            { p: { sub: profile.sub, email: profile.email, emailVerified: profile.emailVerified, name: profile.name }, c: st.c },
            TICKET_TTL_SECONDS,
        );
        return back({ code: ticket });
    } catch (err) {
        console.error('[google] callback failed:', err.message);
        return back({ error: 'google_error' });
    }
};

// Step 3: the app hands the ticket back with its PKCE verifier.
const redeemTicket = (googleCode, codeVerifier) => {
    const ticket = sealed.open('google-ticket', googleCode);
    const expected = ticket && Buffer.from(ticket.c);
    const actual = Buffer.from(challengeOf(codeVerifier));
    if (!ticket || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw new AppError('Google sign-in expired. Please try again', 401, undefined, 'GOOGLE_TOKEN_INVALID');
    }
    return ticket.p;
};

module.exports = { buildAuthUrl, handleCallback, redeemTicket, exchangeCode, challengeOf, isAllowedAppRedirect };
