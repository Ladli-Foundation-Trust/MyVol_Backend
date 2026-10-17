const express = require('express');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { loginLimiter, signupLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/authValidators');
const auth = require('../controllers/authController');

const router = express.Router();

router.post('/signup', signupLimiter, validate({ body: schemas.signup }), auth.signup);
router.post('/login', loginLimiter, validate({ body: schemas.login }), auth.login);
router.post('/refresh', validate({ body: schemas.refresh }), auth.refresh);
router.post('/logout', validate({ body: schemas.refresh }), auth.logout);
router.post('/forgot-password', passwordResetLimiter, validate({ body: schemas.forgotPassword }), auth.forgotPassword);
router.post('/reset-password', passwordResetLimiter, validate({ body: schemas.resetPassword }), auth.resetPassword);

router.get('/me', protect, auth.me);
router.post('/logout-all', protect, auth.logoutAll);
router.patch('/change-password', protect, validate({ body: schemas.changePassword }), auth.changePassword);

module.exports = router;
