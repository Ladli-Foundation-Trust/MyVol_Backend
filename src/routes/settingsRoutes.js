const express = require('express');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { updateSettings } = require('../validators/notificationValidators');
const n = require('../controllers/notificationController');

// The app's Settings & Activity values. Only the notification keys exist so far.
const router = express.Router();
router.use(protect);

router.get('/', n.getSettings);
router.patch('/', validate({ body: updateSettings }), n.updateSettings);

module.exports = router;
