const env = require('../config/env');

// No SMS provider yet (MSG91/Twilio etc. need a DLT-registered sender in India).
// Until then codes are printed to the console outside production. Wiring one in
// means replacing the console branch below; nothing else changes.

// Tests read sent messages (e.g. OTP codes) from here instead of a real phone.
const outbox = [];

// Whether a text can actually reach a phone. In production that needs a provider, so
// phone flows answer 503 PHONE_UNAVAILABLE instead of leaving people waiting for a code.
// Wiring a provider in: make this true when its keys are set.
const available = () => !env.isProd;

const sendSms = async ({ to, text }) => {
    if (env.isTest) {
        outbox.push({ to, text });
        return;
    }
    if (!env.isProd) {
        console.log(`\n[sms] To: ${to}\n${text}\n`);
        return;
    }
    console.error(`[sms] no SMS provider configured; dropped a message to ${to.slice(0, -4)}****`);
};

// Fire-and-forget, like queueMail: a slow provider must not fail or slow the request.
const queueSms = (message) => {
    sendSms(message).catch((err) => console.error('[sms] send failed:', err.message));
};

module.exports = { sendSms, queueSms, outbox, available };
