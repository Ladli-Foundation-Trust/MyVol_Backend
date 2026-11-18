const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const env = require('../config/env');

// Transport, in order: AWS SES (SendRawEmail, same as Skills Forall), then SMTP_URL,
// then the console (never in production). SES gets the raw MIME message built by
// nodemailer's MailComposer, so text + HTML go out as one multipart email.
const buildSesSend = () => {
    const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
    const client = new SESClient({
        region: env.SES_REGION,
        credentials: { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY },
    });
    return async (message) => {
        const raw = await new Promise((resolve, reject) =>
            new MailComposer(message).compile().build((err, buf) => (err ? reject(err) : resolve(buf))),
        );
        await client.send(new SendRawEmailCommand({ RawMessage: { Data: raw } }));
    };
};

const smtp = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;
const deliver = env.sesConfigured ? buildSesSend() : smtp ? (message) => smtp.sendMail(message) : null;

// Addresses that can never receive mail: the Postman collection (example.com), the
// seeds (*.myvolapp.local) and RFC 2606/6761 names. Sending to them would only bounce,
// and bounces count against the SES account's reputation, so they go to the console.
const UNDELIVERABLE = /@(?:(?:[^@]+\.)?example\.(?:com|org|net)|[^@]+\.(?:local|test|example|invalid|localhost)|localhost)$/i;

// True when an email to this address really leaves the server. Callers use it to
// decide whether a code also has to be echoed back for local testing.
const isReservedAddress = (to) => UNDELIVERABLE.test(to);
const willDeliver = (to) => Boolean(to) && !env.isTest && Boolean(deliver) && !isReservedAddress(to);

// Tests read sent mail (e.g. OTP codes) from here instead of a real inbox.
const outbox = [];

const sendMail = async ({ to, subject, text, html }) => {
    const message = { from: env.MAIL_FROM, to, subject, text, ...(html && { html }) };

    if (env.isTest) {
        outbox.push(message);
        return;
    }
    if (willDeliver(to)) {
        await deliver(message);
        if (!env.isProd) console.log(`[mail] sent "${subject}" to ${to}`);
        return;
    }
    if (!env.isProd) {
        console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
        return;
    }
    console.error(`[mail] not delivered (no transport or reserved domain): "${subject}"`);
};

// Fire-and-forget: a slow or failing mail server must not fail the request, and
// the response time must not reveal whether an email was actually sent.
// Move this onto a job queue (BullMQ etc.) once there is more than one instance.
// Phone-only accounts have no email, so `to` may be null: there is nobody to tell.
const queueMail = (message) => {
    if (!message.to) return;
    sendMail(message).catch((err) => console.error(`[mail] "${message.subject}" failed:`, err.message));
};

module.exports = { sendMail, queueMail, willDeliver, isReservedAddress, outbox };
