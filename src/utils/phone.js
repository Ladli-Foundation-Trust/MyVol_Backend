// Numbers are stored in E.164 (+919876543210) so "98765 43210", "+91-98765-43210" and
// "098765 43210" all match the same accounts. A number without a country code is
// taken as Indian, since that is where the app launches.
const DEFAULT_COUNTRY_CODE = '91';

const toE164 = (raw) => {
    const s = String(raw).replace(/[\s\-().]/g, '');
    let e164 = null;
    if (/^\d{10}$/.test(s)) e164 = `+${DEFAULT_COUNTRY_CODE}${s}`;
    else if (/^0\d{10}$/.test(s)) e164 = `+${DEFAULT_COUNTRY_CODE}${s.slice(1)}`;
    else if (/^\+[1-9]\d{7,14}$/.test(s)) e164 = s;

    // Indian mobile numbers are 10 digits starting with 6-9.
    if (e164?.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(e164)) return null;
    return e164;
};

// Login's `identifier` can be an email, a username or a phone. Usernames must contain
// a letter, so anything made only of digits (and phone punctuation) is a phone.
const isPhoneLike = (identifier) => /^\+?[\d\s\-().]{10,20}$/.test(identifier);

module.exports = { toE164, isPhoneLike };
