// Connects to the live notification socket like the app does and prints every event.
// Handy for watching notifications arrive while you click around in Postman.
//
//   npm run ws:listen -- priya_sharma Volunteer2026     log in with username/email/phone + password
//   npm run ws:listen -- <accessToken>                  or use an access token you already have
//
// Reconnects (with a fresh login) when the server restarts. Ctrl+C to stop.
const { WebSocket } = require('ws');
const env = require('../src/config/env');

const HTTP = `http://localhost:${env.PORT}/api/v1`;
const WS = `ws://localhost:${env.PORT}/api/v1/ws`;

const [first, password] = process.argv.slice(2);
if (!first) {
    console.log('Usage: npm run ws:listen -- <username> <password>   or   npm run ws:listen -- <accessToken>');
    process.exit(1);
}

const getToken = async () => {
    if (!password) return first;
    const res = await fetch(`${HTTP}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: first, password, deviceName: 'ws-listen script' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`login failed: ${body.message}`);
    return body.data.accessToken;
};

const time = () => new Date().toLocaleTimeString();

const connect = async () => {
    let token;
    try {
        token = await getToken();
    } catch (err) {
        console.error(`[${time()}] ${err.message}; retrying in 3 s`);
        return setTimeout(connect, 3000);
    }

    const ws = new WebSocket(WS);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'notification') {
            const { notification: n, unreadCount, alert } = event;
            const banner = alert ? `banner (${alert.channelId})` : 'no banner';
            console.log(`[${time()}] 🔔 ${n.type}: ${n.message}  | unread ${unreadCount}, ${banner}, opens ${n.url}`);
        } else if (event.type === 'unread_count') {
            console.log(`[${time()}] badge → ${event.unreadCount}`);
        } else if (event.type === 'ready') {
            console.log(`[${time()}] connected as ${event.userId}, ${event.unreadCount} unread. Waiting for events...`);
        } else {
            console.log(`[${time()}]`, event);
        }
    });
    ws.on('close', (code, reason) => {
        console.log(`[${time()}] closed ${code} ${reason}`);
        // A pasted token can't be renewed; a login can.
        if (code === 4401 && !password) process.exit(1);
        setTimeout(connect, 3000);
    });
    ws.on('error', (err) => console.error(`[${time()}] ${err.message}`));
};

connect();
