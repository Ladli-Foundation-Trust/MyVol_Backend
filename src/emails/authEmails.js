const { APP_NAME } = require('../config/env');

// Plain-text bodies keep these readable in every client and out of spam filters.
// Every message says what to do if the user didn't ask for it.
const footer = `\n\nIf this wasn't you, you can ignore this email or contact ${APP_NAME} support.`;

// Codes also get a small HTML part so the digits stand out and are easy to copy.
// Inline styles only (mail clients drop <style>); the text part stays the fallback.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const codeHtml = (purpose, otp, minutes) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f2fb;font-family:Arial,Helvetica,sans-serif;color:#1d1b29">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:16px">${esc(APP_NAME)}</td></tr>
<tr><td style="font-size:15px;line-height:22px;padding-bottom:20px">Your ${esc(purpose)} code is:</td></tr>
<tr><td align="center" style="padding-bottom:20px"><div style="display:inline-block;font-size:32px;font-weight:bold;letter-spacing:8px;padding:14px 22px;border-radius:12px;background:#f1edff;color:#4b2fd6">${esc(otp)}</div></td></tr>
<tr><td style="font-size:14px;line-height:21px;color:#55526a">It expires in ${minutes} minutes. Never share this code with anyone: ${esc(APP_NAME)} staff will never ask for it.</td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#8a879c;padding-top:24px">If this wasn't you, you can ignore this email or contact ${esc(APP_NAME)} support.</td></tr>
</table></td></tr></table></body></html>`;

const code = (purpose, otp, minutes) => ({
    subject: `${otp} is your ${APP_NAME} ${purpose} code`,
    text: `Your ${purpose} code is ${otp}. It expires in ${minutes} minutes.\n\nNever share this code with anyone. ${APP_NAME} staff will never ask for it.${footer}`,
    html: codeHtml(purpose, otp, minutes),
});

module.exports = {
    verifyEmail: (otp, minutes) => code('verification', otp, minutes),
    passwordReset: (otp, minutes) => code('password reset', otp, minutes),
    emailChange: (otp, minutes) => code('email change', otp, minutes),

    passwordChanged: () => ({
        subject: `Your ${APP_NAME} password was changed`,
        text: `The password for your ${APP_NAME} account was just changed and your other devices were signed out.${footer}`,
    }),

    emailChanged: (newEmail) => ({
        subject: `Your ${APP_NAME} email was changed`,
        text: `The email on your ${APP_NAME} account was changed to ${newEmail}. This address will no longer receive account emails.${footer}`,
    }),

    phoneChanged: () => ({
        subject: `Your ${APP_NAME} phone number was changed`,
        text: `The phone number on your ${APP_NAME} account was changed and your other devices were signed out.${footer}`,
    }),

    googleLinked: () => ({
        subject: `Google sign-in was connected to your ${APP_NAME} account`,
        text: `You can now sign in to ${APP_NAME} with Google.${footer}`,
    }),

    // loginAlerts setting: a sign-in from a device this account hasn't used before.
    newLogin: ({ deviceName, ip, at }) => ({
        subject: `New sign-in to your ${APP_NAME} account`,
        text: `Your ${APP_NAME} account was just signed in to from a new device.\n\nDevice: ${deviceName || 'Unknown device'}\nIP address: ${ip || 'unknown'}\nTime: ${at.toUTCString()}\n\nIf this was you, there's nothing to do. If not, change your password now and sign out of the other devices under Settings > Security.`,
    }),

    deletionScheduled: (date) => ({
        subject: `Your ${APP_NAME} account will be deleted`,
        text: `Your account is scheduled for permanent deletion on ${date.toDateString()}. Log in before then to cancel.${footer}`,
    }),
};
