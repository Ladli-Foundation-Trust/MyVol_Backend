const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const { protect, requireVerified } = require('../middleware/auth');
const { postUpload } = require('../middleware/upload');
const { listQuery } = require('../validators/userValidators');
const schemas = require('../validators/postValidators');
const p = require('../controllers/postController');

const router = express.Router();
router.use(protect);

const post = validate({ params: schemas.postParams });
const list = validate({ query: listQuery });

// Publishing (posts, comments) needs a verified email or phone; reacting doesn't.
router.post('/', requireVerified, limits.postLimiter, postUpload, validate({ body: schemas.createPost }), p.create);

// Fixed paths before /:postId.
router.get('/feed', validate({ query: schemas.feedQuery }), p.feed);
router.get('/explore', validate({ query: schemas.exploreQuery }), p.explore);
router.get('/explore/stats', p.exploreStats);
router.get('/trending', validate({ query: schemas.trendingQuery }), p.trending);
router.get('/saved', list, p.saved);
router.get('/reels', list, p.reels);

router.get('/:postId', post, p.get);
router.patch('/:postId', post, validate({ body: schemas.updatePost }), p.update);
router.delete('/:postId', post, p.remove);

router.post('/:postId/like', limits.engagementLimiter, post, p.like);
router.delete('/:postId/like', limits.engagementLimiter, post, p.unlike);
router.get('/:postId/likes', post, list, p.likes);
router.post('/:postId/save', limits.engagementLimiter, post, p.save);
router.delete('/:postId/save', limits.engagementLimiter, post, p.unsave);
router.post('/:postId/share', limits.engagementLimiter, post, p.share);
router.post('/:postId/view', limits.engagementLimiter, post, validate({ body: schemas.recordView }), p.view);

router.get('/:postId/comments', post, validate({ query: schemas.commentListQuery }), p.comments);
router.post('/:postId/comments', requireVerified, limits.commentLimiter, post, validate({ body: schemas.addComment }), p.addComment);

module.exports = router;
