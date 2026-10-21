const { APP_NAME } = require('../config/env');

// Short enough for one SMS segment (160 chars). The code comes first so Android can
// offer it for autofill.
module.exports = {
    code: (otp, minutes) => `${otp} is your ${APP_NAME} code. It expires in ${minutes} minutes. Never share it with anyone.`,

    phoneChanged: () => `The phone number on your ${APP_NAME} account was changed. If this wasn't you, contact ${APP_NAME} support.`,
};
