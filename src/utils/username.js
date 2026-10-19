const crypto = require('crypto');

// Handles that could be mistaken for staff/official accounts or clash with app routes.
const RESERVED = new Set([
    'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app', 'auth', 'billing',
    'contact', 'explore', 'feed', 'help', 'home', 'info', 'ladli', 'ladlifoundation', 'login',
    'logout', 'mail', 'me', 'mod', 'moderator', 'myvolapp', 'news', 'notifications', 'null',
    'official', 'privacy', 'root', 'search', 'security', 'settings', 'signup', 'staff', 'support',
    'system', 'team', 'terms', 'undefined', 'verified', 'voltour', 'www',
]);

const isReserved = (username) => RESERVED.has(username.replace(/[._]/g, ''));

// Turns an email local part like "Priya.Sharma+news" into a valid handle base.
const usernameBase = (raw) => {
    const base = raw
        .toLowerCase()
        .replace(/\+.*$/, '')
        .replace(/[^a-z0-9._]/g, '')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 20);
    return base.length < 3 || /^\d+$/.test(base) || isReserved(base) ? 'user' : base;
};

// Yields the base, then base + random digits; the caller checks each for availability.
function* usernameCandidates(raw) {
    const base = usernameBase(raw);
    if (base !== 'user') yield base;
    for (let i = 0; i < 4; i++) yield `${base}${crypto.randomInt(1000, 100000)}`;
    yield `user${crypto.randomBytes(5).toString('hex')}`;
}

module.exports = { isReserved, usernameCandidates };
