const express = require('express');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');
const { avatarUpload, requireFile } = require('../middleware/upload');
const schemas = require('../validators/userValidators');
const users = require('../controllers/userController');
const posts = require('../controllers/postController');

const router = express.Router();

// Every profile route needs a signed-in user: the answers depend on who is asking.
router.use(protect);

const user = validate({ params: schemas.userParams });
const list = validate({ query: schemas.listQuery });

// ---------- me (before /:user, and "me" is a reserved username anyway) ----------
router.get('/me', users.getMe);
router.patch('/me', validate({ body: schemas.updateMe }), users.updateMe);
router.patch('/me/username', limits.accountActionLimiter, validate({ body: schemas.changeUsername }), users.changeUsername);
router.put('/me/avatar', limits.uploadLimiter, avatarUpload, requireFile, users.setAvatar);
router.delete('/me/avatar', users.removeAvatar);

router.get('/me/follow-requests', list, users.listRequests);
router.post('/me/follow-requests/:userId/accept', validate({ params: schemas.requestParams }), users.acceptRequest);
router.delete('/me/follow-requests/:userId', validate({ params: schemas.requestParams }), users.declineRequest);
router.get('/me/blocked', list, users.listBlocked);
router.get('/me/muted', list, users.listMuted);
router.get('/me/impact', users.myImpact);
router.get('/me/suggestions', validate({ query: schemas.suggestionsQuery }), users.suggestions);
router.post('/me/suggestions/:userId/dismiss', limits.followLimiter, validate({ params: schemas.requestParams }), users.dismissSuggestion);
router.post('/me/export', limits.exportLimiter, validate({ body: schemas.exportData }), users.exportData);

// ---------- other users: :user is an id or a username ----------
router.get('/:user', user, users.getProfile);
router.get('/:user/followers', user, list, users.followers);
router.get('/:user/following', user, list, users.following);
router.get('/:user/posts', user, list, posts.userPosts);
router.get('/:user/stories', user, users.stories);
router.get('/:user/impact', user, users.impact);
router.post('/:user/follow', limits.followLimiter, user, users.follow);
router.delete('/:user/follow', limits.followLimiter, user, users.unfollow);
router.delete('/:user/follower', user, users.removeFollower);
router.post('/:user/block', limits.followLimiter, user, users.block);
router.delete('/:user/block', limits.followLimiter, user, users.unblock);
router.post('/:user/mute', limits.followLimiter, user, users.mute);
router.delete('/:user/mute', limits.followLimiter, user, users.unmute);

module.exports = router;
