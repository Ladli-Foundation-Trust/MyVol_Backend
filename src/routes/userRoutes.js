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

// ---------- other users: :user is an id or a username ----------
router.get('/:user', user, users.getProfile);
router.get('/:user/followers', user, list, users.followers);
router.get('/:user/following', user, list, users.following);
router.get('/:user/posts', user, list, posts.userPosts);
router.post('/:user/follow', limits.followLimiter, user, users.follow);
router.delete('/:user/follow', limits.followLimiter, user, users.unfollow);
router.delete('/:user/follower', user, users.removeFollower);

module.exports = router;
