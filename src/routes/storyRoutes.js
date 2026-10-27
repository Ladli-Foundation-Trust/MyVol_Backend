const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const { protect, requireVerified } = require('../middleware/auth');
const { storyUpload, requireMedia } = require('../middleware/upload');
const { listQuery } = require('../validators/userValidators');
const schemas = require('../validators/storyValidators');
const stories = require('../services/storyService');

const ok = (res, data, statusCode = 200) => res.status(statusCode).json({ status: 'success', data });

// /api/v1/stories. A person's stories are at /users/:user/stories.
const router = express.Router();
router.use(protect);

const story = validate({ params: schemas.storyParams });

// Publishing needs a verified email or phone, like posts.
router.post('/', requireVerified, limits.storyLimiter, storyUpload, requireMedia, validate({ body: schemas.createStory }), async (req, res) =>
    ok(res, { story: await stories.createStory(req.user.id, req.body, req.file) }, 201),
);

router.get('/tray', async (req, res) => ok(res, await stories.tray(req.user.id)));

router.get('/:storyId', story, async (req, res) => ok(res, { story: await stories.getStory(req.user.id, req.params.storyId) }));

router.delete('/:storyId', story, async (req, res) => {
    await stories.deleteStory(req.user.id, req.params.storyId);
    res.json({ status: 'success', message: 'Story deleted' });
});

router.post('/:storyId/view', limits.engagementLimiter, story, async (req, res) => ok(res, await stories.markSeen(req.user.id, req.params.storyId)));

router.get('/:storyId/viewers', story, validate({ query: listQuery }), async (req, res) =>
    ok(res, await stories.listViewers(req.user.id, req.params.storyId, req.validatedQuery)),
);

module.exports = router;
