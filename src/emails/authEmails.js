const { APP_NAME } = require('../config/env');

// Plain-text bodies keep these readable in every client and out of spam filters.
// Every message says what to do if the user didn't ask for it.
const footer = `\n\nIf this wasn't you, you can ignore this email or contact ${APP_NAME} support.`;

const code = (purpose, otp, minutes) => ({
    subject: `${otp} is your ${APP_NAME} ${purpose} code`,
    text: `Your ${purpose} code is ${otp}. It expires in ${minutes} minutes.\n\nNever share this code with anyone. ${APP_NAME} staff will never ask for it.${footer}`,
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

    googleLinked: () => ({
        subject: `Google sign-in was connected to your ${APP_NAME} account`,
        text: `You can now sign in to ${APP_NAME} with Google.${footer}`,
    }),

    deletionScheduled: (date) => ({
        subject: `Your ${APP_NAME} account will be deleted`,
        text: `Your account is scheduled for permanent deletion on ${date.toDateString()}. Log in before then to cancel.${footer}`,
    }),
};
