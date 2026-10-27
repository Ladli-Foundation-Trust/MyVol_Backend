const express = require('express');
const validate = require('../middleware/validate');
const { protect, restrictTo } = require('../middleware/auth');
const schemas = require('../validators/moderationValidators');
const mod = require('../services/moderationService');

const ok = (res, data) => res.json({ status: 'success', data });

// /api/v1/admin: staff only. REVIEWER and ADMIN review posts, comments and reports;
// only ADMIN suspends accounts, changes roles and reads the audit log. Roles come from
// the database on every request (protect), so a demotion applies at once.
// The first admin is made from the command line: npm run user:role -- <username> ADMIN
const router = express.Router();
router.use(protect, restrictTo('REVIEWER', 'ADMIN'));
const adminOnly = restrictTo('ADMIN');

// ---------- posts ----------
router.get('/posts', validate({ query: schemas.postQueue }), async (req, res) => ok(res, await mod.listPosts(req.user.id, req.validatedQuery)));

router.post('/posts/:postId/approve', validate({ params: schemas.postParams, body: schemas.approvePost }), async (req, res) =>
    ok(res, await mod.approvePost(req.user.id, req.params.postId, req.body)),
);

router.post('/posts/:postId/reject', validate({ params: schemas.postParams, body: schemas.rejectPost }), async (req, res) =>
    ok(res, await mod.rejectPost(req.user.id, req.params.postId, req.body)),
);

// Staff picks (Explore's "Featured" view).
router.post('/posts/:postId/feature', validate({ params: schemas.postParams }), async (req, res) =>
    ok(res, await mod.setFeatured(req.user.id, req.params.postId, true)),
);

router.delete('/posts/:postId/feature', validate({ params: schemas.postParams }), async (req, res) =>
    ok(res, await mod.setFeatured(req.user.id, req.params.postId, false)),
);

// ---------- stories ----------
router.delete('/stories/:storyId', validate({ params: schemas.storyParams, body: schemas.removeStory }), async (req, res) => {
    await mod.removeStory(req.user.id, req.params.storyId, req.body);
    res.json({ status: 'success', message: 'Story removed' });
});

// ---------- comments ----------
router.delete('/comments/:commentId', validate({ params: schemas.commentParams, body: schemas.removeComment }), async (req, res) => {
    await mod.removeComment(req.user.id, req.params.commentId, req.body);
    res.json({ status: 'success', message: 'Comment removed' });
});

// ---------- reports ----------
router.get('/reports', validate({ query: schemas.reportQueue }), async (req, res) => ok(res, await mod.listReports(req.user.id, req.validatedQuery)));

router.post('/reports/:reportId/resolve', validate({ params: schemas.reportParams, body: schemas.resolveReport }), async (req, res) =>
    ok(res, await mod.resolveReport(req.user, req.params.reportId, req.body)),
);

// ---------- users (ADMIN) ----------
router.post('/users/:userId/suspend', adminOnly, validate({ params: schemas.userParams, body: schemas.suspendUser }), async (req, res) =>
    ok(res, await mod.suspendUser(req.user.id, req.params.userId, req.body)),
);

router.post('/users/:userId/unsuspend', adminOnly, validate({ params: schemas.userParams, body: schemas.unsuspendUser }), async (req, res) =>
    ok(res, await mod.unsuspendUser(req.user.id, req.params.userId, req.body)),
);

router.post('/users/:userId/role', adminOnly, validate({ params: schemas.userParams, body: schemas.setRole }), async (req, res) =>
    ok(res, await mod.setRole(req.user.id, req.params.userId, req.body)),
);

router.get('/actions', adminOnly, validate({ query: schemas.actionsQuery }), async (req, res) => ok(res, await mod.listActions(req.validatedQuery)));

module.exports = router;
