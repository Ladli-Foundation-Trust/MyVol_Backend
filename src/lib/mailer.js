const nodemailer = require('nodemailer');
const env = require('../config/env');

const transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

// Tests read sent mail (e.g. OTP codes) from here instead of a real inbox.
const outbox = [];

const sendMail = async ({ to, subject, text }) => {
    const message = { from: env.MAIL_FROM, to, subject, text };

    if (env.isTest) {
        outbox.push(message);
        return;
    }
    if (transport) {
        await transport.sendMail(message);
        return;
    }
    if (!env.isProd) {
        console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
        return;
    }
    console.error(`[mail] SMTP_URL not set; dropped "${subject}"`);
};

// Fire-and-forget: a slow or failing mail server must not fail the request, and
// the response time must not reveal whether an email was actually sent.
// Move this onto a job queue (BullMQ etc.) once there is more than one instance.
// Phone-only accounts have no email, so `to` may be null: there is nobody to tell.
const queueMail = (message) => {
    if (!message.to) return;
    sendMail(message).catch((err) => console.error(`[mail] "${message.subject}" failed:`, err.message));
};

module.exports = { sendMail, queueMail, outbox };
