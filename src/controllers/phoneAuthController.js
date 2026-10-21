const phoneAuth = require('../services/phoneAuthService');
const { requestContext, sendSession, sendUser, sendMessage, clearRefreshCookie } = require('./authController');

exports.sendCode = async (req, res) => {
    const dev = await phoneAuth.sendCode(req.body, requestContext(req));
    const message =
        req.body.purpose === 'login'
            ? 'If this number has an account, we sent it a code'
            : 'We sent a code to your phone';
    sendMessage(res, message, dev);
};

exports.verifyCode = async (req, res) => {
    res.json({ status: 'success', data: await phoneAuth.verifyCode(req.body) });
};

exports.signup = async (req, res) => {
    sendSession(res, 201, await phoneAuth.signup(req.body, requestContext(req)));
};

exports.login = async (req, res) => {
    sendSession(res, 200, await phoneAuth.login(req.body, requestContext(req)));
};

exports.resetPassword = async (req, res) => {
    await phoneAuth.resetPassword(req.body, requestContext(req));
    clearRefreshCookie(res);
    sendMessage(res, 'Password updated. Please log in with your new password');
};

exports.changePhone = async (req, res) => {
    sendUser(res, await phoneAuth.changePhone(req.user, req.body, requestContext(req)));
};
