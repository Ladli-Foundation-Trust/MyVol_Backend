const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const { protect } = require('../middleware/auth');
const schemas = require('../validators/moderationValidators');
const reports = require('../services/reportService');

// /api/v1/reports: anyone signed in can report what they can see (anonymously).
const router = express.Router();
router.use(protect, limits.reportLimiter);

router.post('/', validate({ body: schemas.createReport }), async (req, res) => {
    const result = await reports.createReport(req.user.id, req.body);
    res.status(result.alreadyReported ? 200 : 201).json({ status: 'success', data: result });
});

router.post('/problem', validate({ body: schemas.problemReport }), async (req, res) => {
    res.status(201).json({ status: 'success', data: await reports.createProblemReport(req.user.id, req.body) });
});

module.exports = router;
