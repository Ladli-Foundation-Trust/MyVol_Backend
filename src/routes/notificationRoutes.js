const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const { protect } = require('../middleware/auth');
const { listQuery } = require('../validators/userValidators');
const schemas = require('../validators/notificationValidators');
const n = require('../controllers/notificationController');

const router = express.Router();
router.use(protect);

const notification = validate({ params: schemas.notificationParams });

router.get('/', validate({ query: listQuery }), n.list);
router.get('/unread-count', n.unreadCount);
router.post('/read-all', validate({ body: schemas.markAllRead }), n.markAllRead);
// Checks the app's WebSocket + banner code (live delivery itself is at /api/v1/ws).
router.post('/test', limits.testNotificationLimiter, n.test);

router.post('/:notificationId/read', notification, n.markRead);
router.delete('/:notificationId', notification, n.remove);

module.exports = router;
