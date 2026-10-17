const env = require('../config/env');
const authService = require('../services/authService');

const REFRESH_COOKIE = 'refreshToken';

const cookieOptions = {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'strict',
    path: '/api/v1/auth',
};

const requestContext = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];

const sendSession = (res, statusCode, { user, accessToken, refreshToken, refreshTokenExpiresAt }) => {
    res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOptions, expires: refreshTokenExpiresAt });
    res.status(statusCode).json({
        status: 'success',
        data: { user, accessToken, refreshToken, refreshTokenExpiresAt },
    });
};

const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, cookieOptions);

exports.signup = async (req, res) => {
    sendSession(res, 201, await authService.signup(req.body, requestContext(req)));
};

exports.login = async (req, res) => {
    sendSession(res, 200, await authService.login(req.body, requestContext(req)));
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
    await authService.logout(readRefreshToken(req));
    clearRefreshCookie(res);
    res.json({ status: 'success', message: 'Logged out' });
};

exports.logoutAll = async (req, res) => {
    await authService.logoutAll(req.user.id);
    clearRefreshCookie(res);
    res.json({ status: 'success', message: 'Logged out from all devices' });
};

exports.me = async (req, res) => {
    res.json({ status: 'success', data: { user: await authService.getMe(req.user.id) } });
};

exports.forgotPassword = async (req, res) => {
    await authService.requestPasswordReset(req.body);
    res.json({
        status: 'success',
        message: 'If an account exists for this email, a reset code has been sent',
    });
};

exports.resetPassword = async (req, res) => {
    await authService.resetPassword(req.body);
    clearRefreshCookie(res);
    res.json({ status: 'success', message: 'Password updated. Please log in with your new password' });
};

exports.changePassword = async (req, res) => {
    sendSession(res, 200, await authService.changePassword(req.user.id, req.body, requestContext(req)));
};
