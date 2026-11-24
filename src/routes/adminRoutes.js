const express = require('express');
const validate = require('../middleware/validate');
const { protect, restrictTo } = require('../middleware/auth');
const schemas = require('../validators/moderationValidators');
const mod = require('../services/moderationService');
const admin = require('../services/adminService');
const announcements = require('../services/announcementService');
const { announcementImageUpload, requireImage } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimit');
const a = require('../validators/adminValidators');

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

// ---------- ripple links ----------
// Inspired posts whose author asked for a review because nobody could vouch.
router.get('/ripple', validate({ query: schemas.rippleQueue }), async (req, res) => ok(res, await mod.listRippleQueue(req.user.id, req.validatedQuery)));

router.post('/posts/:postId/ripple/verify', validate({ params: schemas.postParams, body: schemas.approvePost }), async (req, res) =>
    ok(res, await mod.verifyRipple(req.user.id, req.params.postId, req.body)),
);

router.post('/posts/:postId/ripple/reject', validate({ params: schemas.postParams, body: schemas.rejectPost }), async (req, res) =>
    ok(res, await mod.rejectRipple(req.user.id, req.params.postId, req.body)),
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

// ---------- admin panel read models (adminService) ----------
// Dashboards, analytics and the browse/search tables of myvol-admin. Reviewers get the
// content views; people, security and system are ADMIN only.

router.get('/queues', async (req, res) => ok(res, await admin.queues()));
router.get('/overview', async (req, res) => ok(res, await admin.overview()));
router.get('/analytics', validate({ query: a.analyticsQuery }), async (req, res) => ok(res, await admin.analytics(req.validatedQuery)));

router.get('/content/posts', validate({ query: a.postsQuery }), async (req, res) => ok(res, await admin.listPosts(req.validatedQuery)));
router.get('/content/posts/:postId', validate({ params: schemas.postParams }), async (req, res) => ok(res, await admin.getPost(req.user.id, req.params.postId)));
router.get('/content/comments', validate({ query: a.commentsQuery }), async (req, res) => ok(res, await admin.listComments(req.validatedQuery)));
router.get('/content/stories', validate({ query: a.searchQuery }), async (req, res) => ok(res, await admin.listStories(req.validatedQuery)));
router.get('/content/hashtags', validate({ query: a.searchQuery }), async (req, res) => ok(res, await admin.listHashtags(req.validatedQuery)));

router.get('/users', adminOnly, validate({ query: a.usersQuery }), async (req, res) => ok(res, await admin.listUsers(req.validatedQuery)));
router.get('/users/:userId', adminOnly, validate({ params: schemas.userParams }), async (req, res) => ok(res, await admin.getUser(req.params.userId)));
router.post('/users/:userId/logout-all', adminOnly, validate({ params: schemas.userParams, body: a.withReason }), async (req, res) =>
    ok(res, await admin.logoutEverywhere(req.user.id, req.params.userId, req.body)),
);
router.post('/users/:userId/verify-email', adminOnly, validate({ params: schemas.userParams, body: a.withReason }), async (req, res) =>
    ok(res, await admin.verifyEmail(req.user.id, req.params.userId, req.body)),
);
router.post('/users/:userId/clear-profile', adminOnly, validate({ params: schemas.userParams, body: a.clearProfile }), async (req, res) =>
    ok(res, await admin.clearProfile(req.user.id, req.params.userId, req.body)),
);

router.get('/security', adminOnly, validate({ query: a.authEventsQuery }), async (req, res) => ok(res, await admin.listAuthEvents(req.validatedQuery)));
router.get('/system', adminOnly, async (req, res) => ok(res, await admin.system()));

// ---------- announcements (ADMIN, D84) ----------
// A message from the MyVol team to everyone, or to a filtered audience; now or later.
router.get('/announcements', adminOnly, validate({ query: a.announcementsQuery }), async (req, res) =>
    ok(res, await announcements.listAnnouncements(req.validatedQuery)),
);
router.get('/announcements/options', adminOnly, async (req, res) => ok(res, { causes: a.PREFERRED_AREAS }));
router.post('/announcements/audience', adminOnly, validate({ body: a.audienceBody }), async (req, res) =>
    ok(res, await announcements.audienceCount(req.body.audience)),
);
// The picture first (multipart, field "image"); the answer's imageKey goes in the announcement.
router.post('/announcements/image', adminOnly, uploadLimiter, announcementImageUpload, requireImage, async (req, res) =>
    res.status(201).json({ status: 'success', data: await announcements.uploadImage(req.file) }),
);
router.post('/announcements', adminOnly, validate({ body: a.createAnnouncement }), async (req, res) =>
    res.status(201).json({ status: 'success', data: await announcements.create(req.user.id, req.body) }),
);
router.get('/announcements/:announcementId', adminOnly, validate({ params: a.announcementParams }), async (req, res) =>
    ok(res, await announcements.getAnnouncement(req.params.announcementId)),
);
router.post('/announcements/:announcementId/send-now', adminOnly, validate({ params: a.announcementParams }), async (req, res) =>
    ok(res, await announcements.sendNow(req.user.id, req.params.announcementId)),
);
router.post('/announcements/:announcementId/cancel', adminOnly, validate({ params: a.announcementParams }), async (req, res) =>
    ok(res, await announcements.cancel(req.user.id, req.params.announcementId)),
);
router.post('/announcements/:announcementId/withdraw', adminOnly, validate({ params: a.announcementParams, body: a.withReason }), async (req, res) =>
    ok(res, await announcements.withdraw(req.user.id, req.params.announcementId, req.body)),
);

module.exports = router;
