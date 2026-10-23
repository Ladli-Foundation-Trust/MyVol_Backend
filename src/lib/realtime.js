const { WebSocketServer, WebSocket } = require('ws');
const prisma = require('./prisma');
const env = require('../config/env');
const { authenticate } = require('../middleware/auth');

// Our own real-time channel to the app: one WebSocket per logged-in device at
// ws(s)://HOST/api/v1/ws. No push service is involved. Notifications reach a phone
// while the app is open (or briefly in the background); a closed app catches up from
// GET /notifications when it opens. Chat (later phase) will use the same connection.
//
// Protocol (JSON text frames):
//   app → server  { type: 'auth', token: '<accessToken>' }   first message, within 10 s
//                 { type: 'ping' }                           optional app-level keepalive
//   server → app  { type: 'ready', userId, ...onReady() }    after a successful auth
//                 { type: 'pong' }
//                 { type: 'error', code, message }           bad message (connection stays)
//                 anything sent with sendToUser()            e.g. { type: 'notification', ... }
// The access token may instead be sent as `Authorization: Bearer` on the upgrade request.
// It is never put in the URL, where it would end up in logs.
//
// Close codes: 4401 not authenticated / session ended (reason = the API error code, e.g.
// TOKEN_EXPIRED → refresh and reconnect; SESSION_INVALID / ACCOUNT_INACTIVE → log out),
// 4408 no auth in time, 4429 too many connections, 1001 server shutting down (reconnect).
//
// Connections live in this process's memory. With more than one server instance, a
// Redis pub/sub fan-out goes in sendToUser; nothing else changes.

const PATH = '/api/v1/ws';
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 4 * 1024;

const CLOSE = { UNAUTHORIZED: 4401, AUTH_TIMEOUT: 4408, TOO_MANY: 4429, GOING_AWAY: 1001 };

// userId → Set of authenticated sockets (one per device/tab).
const sockets = new Map();

const send = (ws, event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
};

const add = (ws) => {
    let set = sockets.get(ws.user.id);
    if (!set) sockets.set(ws.user.id, (set = new Set()));
    set.add(ws);
};

const remove = (ws) => {
    const set = ws.user && sockets.get(ws.user.id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) sockets.delete(ws.user.id);
};

// Sends `event` to every connected device of `userId`. Returns how many got it.
const sendToUser = (userId, event) => {
    const set = sockets.get(userId);
    if (!set) return 0;
    const data = JSON.stringify(event);
    let sent = 0;
    for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
            sent += 1;
        }
    }
    return sent;
};

const connectedDevices = (userId) => sockets.get(userId)?.size ?? 0;

// Closes every connection of a user at once (e.g. suspended), instead of waiting for
// the 30 s session check.
const disconnectUser = (userId, reason = 'ACCOUNT_INACTIVE') => {
    for (const ws of sockets.get(userId) ?? []) ws.close(CLOSE.UNAUTHORIZED, reason);
};

// Closes a socket for an auth problem; the reason is the API's error code.
const reject = (ws, err) => ws.close(CLOSE.UNAUTHORIZED, err.code || (err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'));

// Same rule as express's 'cors' setup in app.js: apps send no Origin; browsers must be listed.
const originAllowed = (origin) => !origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin);

// `onReady(user)` adds fields to the 'ready' event (e.g. the unread count). Returns
// { close() } for graceful shutdown.
const attach = (server, { onReady } = {}) => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

    const login = async (ws, token) => {
        let user;
        try {
            user = await authenticate(token);
        } catch (err) {
            return reject(ws, err);
        }
        if (ws.readyState !== WebSocket.OPEN) return; // gave up meanwhile
        if (connectedDevices(user.id) >= env.MAX_SESSIONS_PER_USER) {
            return ws.close(CLOSE.TOO_MANY, 'TOO_MANY_CONNECTIONS');
        }
        clearTimeout(ws.authTimer);
        ws.user = { id: user.id, sessionId: user.sessionId };
        add(ws);
        const extra = onReady ? await onReady(ws.user).catch(() => ({})) : {};
        send(ws, { type: 'ready', userId: user.id, ...extra });
    };

    const onMessage = (ws, raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Messages must be JSON' });
        }
        if (msg?.type === 'auth') {
            if (ws.user || ws.authenticating) return send(ws, { type: 'error', code: 'ALREADY_AUTHENTICATED', message: 'Already logged in' });
            if (typeof msg.token !== 'string' || msg.token.length > 2048) return reject(ws, { code: 'NOT_AUTHENTICATED' });
            ws.authenticating = true;
            return login(ws, msg.token).finally(() => (ws.authenticating = false));
        }
        if (!ws.user) return send(ws, { type: 'error', code: 'NOT_AUTHENTICATED', message: 'Send { type: "auth", token } first' });
        if (msg?.type === 'ping') return send(ws, { type: 'pong' });
        return send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown message type: ${msg?.type}` });
    };

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        ws.on('message', (raw) => onMessage(ws, raw));
        ws.on('close', () => {
            clearTimeout(ws.authTimer);
            remove(ws);
        });
        ws.on('error', () => {}); // e.g. a frame over maxPayload: ws closes the socket itself

        const [scheme, token] = (req.headers.authorization || '').split(' ');
        if (scheme === 'Bearer' && token) {
            ws.authenticating = true;
            login(ws, token).finally(() => (ws.authenticating = false));
        }
        ws.authTimer = setTimeout(() => !ws.user && ws.close(CLOSE.AUTH_TIMEOUT, 'AUTH_TIMEOUT'), AUTH_TIMEOUT_MS);
    });

    server.on('upgrade', (req, socket, head) => {
        const { pathname } = new URL(req.url, 'http://localhost');
        if (pathname !== PATH || !originAllowed(req.headers.origin)) {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    // Disconnects devices whose session ended (logout, revoked, password change, ban):
    // the socket outlives the 15-minute access token it logged in with.
    const checkSessions = async () => {
        const authed = [...wss.clients].filter((ws) => ws.user);
        if (authed.length === 0) return;
        try {
            const live = await prisma.session.findMany({
                where: {
                    id: { in: [...new Set(authed.map((ws) => ws.user.sessionId))] },
                    revokedAt: null,
                    expiresAt: { gt: new Date() },
                    user: { status: 'ACTIVE' },
                },
                select: { id: true },
            });
            const liveIds = new Set(live.map((s) => s.id));
            for (const ws of authed) if (!liveIds.has(ws.user.sessionId)) ws.close(CLOSE.UNAUTHORIZED, 'SESSION_INVALID');
        } catch (err) {
            console.error('[realtime] session check failed:', err.message);
        }
    };

    // Every 30 s: drop sockets that stopped answering pings (phone went offline or
    // the app was killed), then re-check sessions.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
        checkSessions();
    }, HEARTBEAT_MS);
    heartbeat.unref();

    return {
        checkSessions,
        close: () => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.close(CLOSE.GOING_AWAY, 'SERVER_SHUTDOWN');
            wss.close();
        },
    };
};

module.exports = { PATH, CLOSE, attach, sendToUser, connectedDevices, disconnectUser };
