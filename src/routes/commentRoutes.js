const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const { protect } = require('../middleware/auth');
const { listQuery } = require('../validators/userValidators');
const { commentParams } = require('../validators/postValidators');
const p = require('../controllers/postController');

// Comments are created under a post (POST /posts/:postId/comments); everything
// done to an existing comment lives here.
const router = express.Router();
router.use(protect);

const comment = validate({ params: commentParams });

router.get('/:commentId/replies', comment, validate({ query: listQuery }), p.replies);
router.delete('/:commentId', comment, p.deleteComment);
router.post('/:commentId/like', limits.engagementLimiter, comment, p.likeComment);
router.delete('/:commentId/like', limits.engagementLimiter, comment, p.unlikeComment);

module.exports = router;
