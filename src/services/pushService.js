// Phone notifications over FCM when the app isn't open (decision D77).
//
// Our own WebSocket (lib/realtime.js) delivers everything while the app is open. In the
// background or after it was swiped away, Android won't let the app listen, and phone
// makers (Motorola, Xiaomi, Oppo, Vivo…) freeze a woken app before its code can run. So,
// like every major social app, we send FCM a DISPLAY message: Android shows it itself,
// with no app code involved, in every state. Our server still decides everything: whether
// to show it at all (settings, re-alert window), the channel (sound/vibrate/quiet hours),
// and the text. `tag` = the notification id, so the app's own copy of the same
// notification (from the socket) replaces this one instead of stacking.
//
// FCM HTTP v1: POST https://fcm.googleapis.com/v1/projects/<project>/messages:send with an
// OAuth2 token from the service-account key (google-auth-library). Free, no message limit.
const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');
const env = require('../config/env');
const prisma = require('../lib/prisma');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
// A phone that was off longer than this doesn't need every old notification on its lock
// screen: the app loads the list when it opens.
const TTL = '86400s';
const BRAND_COLOR = '#6754FD';

// ---------- transport ----------

// The FCM sender, or false when no key is configured (push off). Tests swap in their own
// transport with setTransport(); nothing in the test suite talks to Google.
let transport = null;

// FCM says the token is gone (app uninstalled, data cleared, token rotated): forget it.
// Only these: a plain INVALID_ARGUMENT can also mean a bad payload, and deleting every
// token over our own bug would silence all phones.
const isDeadToken = (status, body) =>
    status === 404 || /UNREGISTERED/.test(body) || (status === 400 && /registration token/i.test(body));

// Worth one more try: rate limits and Google-side hiccups.
const isRetryable = (status) => !status || status === 429 || status >= 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What FCM gets for one notification. `data` values must be strings.
const toMessage = (token, { notificationId, title, body, imageUrl, url, channelId }) => ({
    token,
    // Usually no title: Android already shows the app name above it, and the text starts
    // with who did it ("Priya Sharma commented: …"). Announcements send their headline.
    // imageUrl (announcements): Android downloads it and shows it as the big picture.
    notification: { ...(title && { title }), body, ...(imageUrl && { image: imageUrl }) },
    data: { type: 'notification', notificationId, url: url ?? '', tag: notificationId },
    android: {
        priority: 'HIGH',
        ttl: TTL,
        notification: { channel_id: channelId, tag: notificationId, color: BRAND_COLOR },
    },
});

const fcmTransport = (credentials) => {
    const projectId = credentials.project_id;
    const auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    // Resolves 'sent' | 'dead' | 'failed'.
    const send = async (token, payload, attempt = 1) => {
        try {
            const http = await auth.getClient();
            await http.request({ url, method: 'POST', data: { message: toMessage(token, payload) }, timeout: 10000 });
            return 'sent';
        } catch (err) {
            const status = err.response?.status;
            const body = JSON.stringify(err.response?.data ?? '');
            if (isDeadToken(status, body)) return 'dead';
            if (attempt === 1 && isRetryable(status)) {
                await sleep(1000);
                return send(token, payload, 2);
            }
            console.warn(`[push] FCM ${status ?? ''} ${(body || err.message).slice(0, 200)}`);
            return 'failed';
        }
    };
    send.projectId = projectId;
    return send;
};

// The service-account key, from FIREBASE_SERVICE_ACCOUNT_JSON (the JSON itself or its
// base64, handy on hosts that only take env vars) or FIREBASE_SERVICE_ACCOUNT_PATH (a
// file, relative to the project root). Null = push off.
const loadCredentials = () => {
    const inline = env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (inline) {
        const text = inline.trim().startsWith('{') ? inline : Buffer.from(inline, 'base64').toString('utf8');
        return JSON.parse(text);
    }
    const keyPath = env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!keyPath) return null;
    const file = path.resolve(__dirname, '../..', keyPath);
    if (!fs.existsSync(file)) {
        console.warn(`[push] ${keyPath} not found: push notifications are off`);
        return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const getTransport = () => {
    if (transport !== null) return transport;
    try {
        const credentials = loadCredentials();
        if (!credentials) return (transport = false);
        if (!credentials.project_id || !credentials.private_key || !credentials.client_email) {
            console.warn('[push] the Firebase service-account key is incomplete: push notifications are off');
            return (transport = false);
        }
        return (transport = fcmTransport(credentials));
    } catch (err) {
        console.warn(`[push] can't read the Firebase service-account key (${err.message}): push notifications are off`);
        return (transport = false);
    }
};

// For tests: fn(token, payload) → 'sent' | 'dead' | 'failed'; null = back to the env config.
const setTransport = (fn) => {
    transport = fn;
};

const isEnabled = () => Boolean(getTransport());

// One line at startup, so a deploy shows at a glance whether closed-app delivery is on.
const describe = () => {
    const t = getTransport();
    return t ? `on (Firebase project ${t.projectId ?? 'custom transport'})` : 'off (no Firebase service-account key)';
};

// ---------- tokens (one per session) ----------

// The app registers its FCM token after login and whenever FCM rotates it. A token seen
// on another session (another account signed in on this phone) moves to this one, so a
// shared phone never gets the previous account's notifications.
const registerToken = async (userId, sessionId, { token, platform }) => {
    await prisma.$transaction([
        prisma.pushToken.deleteMany({ where: { OR: [{ token }, { sessionId }] } }),
        prisma.pushToken.create({ data: { token, sessionId, userId, platform } }),
    ]);
    return { registered: true, enabled: isEnabled() };
};

const unregisterToken = async (sessionId) => {
    const { count } = await prisma.pushToken.deleteMany({ where: { sessionId } });
    return { removed: count > 0 };
};

// Live sessions of active accounts only: logged-out, revoked or expired logins never get
// a notification.
const tokensFor = (userId) =>
    prisma.pushToken.findMany({
        where: { userId, session: { revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } } },
        select: { token: true },
    });

// ---------- sending ----------

// Shows notification `notificationId` on every live device of `userId`:
// { notificationId, title?, body, imageUrl?, url, channelId }. Never throws: a push failure must not break
// the action that caused it. Resolves to one result per device.
const notify = async (userId, payload) => {
    const send = getTransport();
    if (!send) return [];
    try {
        const tokens = await tokensFor(userId);
        return await Promise.all(
            tokens.map(async ({ token }) => {
                const result = await send(token, payload);
                if (result === 'dead') await prisma.pushToken.deleteMany({ where: { token } });
                return result;
            }),
        );
    } catch (err) {
        console.warn('[push] send failed:', err.message);
        return [];
    }
};

module.exports = { isEnabled, describe, setTransport, registerToken, unregisterToken, tokensFor, notify, toMessage };
