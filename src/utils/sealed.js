const crypto = require('node:crypto');
const env = require('../config/env');

// Small encrypted, expiring tokens (AES-256-GCM) for state that has to travel through
// a browser and come back unchanged, e.g. the Google OAuth `state` and the one-time
// code handed back to the app. The server keeps nothing: tampering breaks the GCM tag
// and the reader can't see inside. Each purpose gets its own key (HKDF), so a token made
// for one purpose can't be replayed as another.
const keyFor = (purpose) =>
    Buffer.from(crypto.hkdfSync('sha256', env.JWT_ACCESS_SECRET, 'myvolapp-sealed-v1', purpose, 32));

const seal = (purpose, payload, ttlSeconds) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
    const body = JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
    const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
};

// null for anything forged, damaged, made for another purpose or expired.
const open = (purpose, token) => {
    try {
        const raw = Buffer.from(String(token), 'base64url');
        if (raw.length < 29) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
        const payload = JSON.parse(body);
        if (!(payload.exp > Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
};

module.exports = { seal, open };
