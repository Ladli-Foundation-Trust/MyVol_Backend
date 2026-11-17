const express = require('express');
const validate = require('../middleware/validate');
const { postParams } = require('../validators/postValidators');
const { userParams } = require('../validators/userValidators');
const previews = require('../services/previewService');

// Link previews for myvol.org (D78). Public on purpose: no `protect`. Only what a
// logged-out stranger may see (previewService). Cached briefly by the website and any
// CDN in front of it; a post made private disappears from previews within minutes.
const router = express.Router();

const ok = (res, data) => {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json({ status: 'success', data });
};

router.get('/posts/:postId', validate({ params: postParams }), async (req, res) => ok(res, await previews.getPostPreview(req.params.postId)));
router.get('/users/:user', validate({ params: userParams }), async (req, res) => ok(res, await previews.getUserPreview(req.params.user)));
router.get('/ripple/:user', validate({ params: userParams }), async (req, res) => ok(res, await previews.getRipplePreview(req.params.user)));

module.exports = router;
