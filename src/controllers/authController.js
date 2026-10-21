const env = require('../config/env');
const authService = require('../services/authService');
const accountService = require('../services/accountService');
const sessionService = require('../services/sessionService');

const REFRESH_COOKIE = 'refreshToken';

// The cookie is for a future web client; the mobile app stores the body's refreshToken
// in SecureStore. Scoped to /api/v1/auth so it is never sent to any other route.
const cookieOptions = {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'strict',
    path: '/api/v1/auth',
};

const requestContext = (req) => ({
    userAgent: req.get('user-agent'),
    ip: req.ip,
    deviceName: req.body?.deviceName,
});

const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];

const sendSession = (res, statusCode, { user, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, ...extra }) => {
    res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOptions, expires: refreshTokenExpiresAt });
    res.status(statusCode).json({
        status: 'success',
        data: { user, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, ...extra },
    });
};

const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, cookieOptions);

const sendUser = (res, user) => res.json({ status: 'success', data: { user } });

const sendMessage = (res, message, data) =>
    res.json({ status: 'success', message, ...(data && Object.keys(data).length > 0 && { data }) });

// Shared with phoneAuthController.
Object.assign(exports, { requestContext, sendSession, sendUser, sendMessage, clearRefreshCookie });

// ---------- public ----------

exports.signup = async (req, res) => {
    sendSession(res, 201, await authService.signup(req.body, requestContext(req)));
};

exports.login = async (req, res) => {
    sendSession(res, 200, await authService.login(req.body, requestContext(req)));
};

exports.google = async (req, res) => {
    const session = await authService.loginWithGoogle(req.body, requestContext(req));
    sendSession(res, session.isNewUser ? 201 : 200, session);
};

exports.refresh = async (req, res) => {
    try {
        sendSession(res, 200, await authService.refresh(readRefreshToken(req), requestContext(req)));
    } catch (err) {
        clearRefreshCookie(res);
        throw err;
    }
};

exports.logout = async (req, res) => {
    await authService.logout(readRefreshToken(req), requestContext(req));
    clearRefreshCookie(res);
    sendMessage(res, 'Logged out');
};

exports.usernameAvailable = async (req, res) => {
    res.json({ status: 'success', data: await authService.checkUsername(req.validatedQuery.username) });
};

exports.forgotPassword = async (req, res) => {
    const dev = await authService.requestPasswordReset(req.body, requestContext(req));
    sendMessage(res, 'If an account exists for this email, a reset code has been sent', dev);
};

exports.resetPassword = async (req, res) => {
    await authService.resetPassword(req.body, requestContext(req));
    clearRefreshCookie(res);
    sendMessage(res, 'Password updated. Please log in with your new password');
};

// ---------- signed in ----------

exports.me = async (req, res) => {
    sendUser(res, await authService.getMe(req.user.id));
};

exports.verifyEmail = async (req, res) => {
    sendUser(res, await authService.verifyEmail(req.user.id, req.body, requestContext(req)));
};

exports.resendEmailVerification = async (req, res) => {
    const dev = await authService.resendEmailVerification(req.user.id);
    sendMessage(res, 'A new verification code has been sent', dev);
};

exports.changePassword = async (req, res) => {
    sendUser(res, await authService.changePassword(req.user, req.body, requestContext(req)));
};

exports.requestEmailChange = async (req, res) => {
    const dev = await authService.requestEmailChange(req.user, req.body, requestContext(req));
    sendMessage(res, 'We sent a code to your new email. Enter it to confirm the change', dev);
};

exports.confirmEmailChange = async (req, res) => {
    sendUser(res, await authService.confirmEmailChange(req.user, req.body, requestContext(req)));
};

exports.listSessions = async (req, res) => {
    const sessions = await sessionService.listSessions(req.user.id, req.user.sessionId);
    res.json({ status: 'success', data: { sessions } });
};

exports.revokeSession = async (req, res) => {
    await sessionService.revokeUserSession(req.user.id, req.params.sessionId);
    if (req.params.sessionId === req.user.sessionId) clearRefreshCookie(res);
    sendMessage(res, 'Session logged out');
};

exports.logoutAll = async (req, res) => {
    await authService.logoutAll(req.user.id, requestContext(req));
    clearRefreshCookie(res);
    sendMessage(res, 'Logged out from all devices');
};

exports.deactivate = async (req, res) => {
    await accountService.deactivate(req.user, req.body, requestContext(req));
    clearRefreshCookie(res);
    sendMessage(res, 'Your account is deactivated. Log in any time to reactivate it');
};

exports.deleteAccount = async (req, res) => {
    const result = await accountService.scheduleDeletion(req.user, req.body, requestContext(req));
    clearRefreshCookie(res);
    sendMessage(res, 'Your account will be deleted. Log in before the date to cancel', result);
};
