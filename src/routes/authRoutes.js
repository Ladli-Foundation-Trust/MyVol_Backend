const express = require('express');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');
const schemas = require('../validators/authValidators');
const auth = require('../controllers/authController');

const router = express.Router();

// Responses here carry tokens and personal data: never cache them anywhere.
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// ---------- public ----------
router.post('/signup', limits.signupLimiter, validate({ body: schemas.signup }), auth.signup);
router.post('/login', limits.loginLimiter, validate({ body: schemas.login }), auth.login);
router.post('/google', limits.loginLimiter, validate({ body: schemas.google }), auth.google);
router.post('/refresh', limits.refreshLimiter, validate({ body: schemas.refresh }), auth.refresh);
router.post('/logout', limits.refreshLimiter, validate({ body: schemas.refresh }), auth.logout);
router.get('/username-available', limits.usernameCheckLimiter, validate({ query: schemas.usernameQuery }), auth.usernameAvailable);
router.post('/forgot-password', limits.passwordResetLimiter, validate({ body: schemas.forgotPassword }), auth.forgotPassword);
router.post('/reset-password', limits.passwordResetLimiter, validate({ body: schemas.resetPassword }), auth.resetPassword);

// ---------- signed in (protect per route, so unknown paths still 404) ----------
router.get('/me', protect, auth.me);

router.post('/email/verify', protect, limits.accountActionLimiter, validate({ body: schemas.verifyCode }), auth.verifyEmail);
router.post('/email/verify/resend', protect, limits.accountActionLimiter, auth.resendEmailVerification);
router.post('/email/change', protect, limits.accountActionLimiter, validate({ body: schemas.emailChange }), auth.requestEmailChange);
router.post('/email/change/confirm', protect, limits.accountActionLimiter, validate({ body: schemas.verifyCode }), auth.confirmEmailChange);

router.patch('/change-password', protect, limits.accountActionLimiter, validate({ body: schemas.changePassword }), auth.changePassword);

router.get('/sessions', protect, auth.listSessions);
router.delete('/sessions/:sessionId', protect, validate({ params: schemas.sessionParams }), auth.revokeSession);
router.post('/logout-all', protect, auth.logoutAll);

router.post('/account/deactivate', protect, limits.accountActionLimiter, validate({ body: schemas.confirmPassword }), auth.deactivate);
router.post('/account/delete', protect, limits.accountActionLimiter, validate({ body: schemas.confirmPassword }), auth.deleteAccount);

module.exports = router;
