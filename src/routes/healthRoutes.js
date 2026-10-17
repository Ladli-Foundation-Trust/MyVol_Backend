const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

router.get('/', (req, res) => res.json({ status: 'ok' }));

router.get('/ready', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: 'ready', checks: { postgres: 'ok' } });
    } catch (err) {
        res.status(503).json({ status: 'degraded', checks: { postgres: `fail: ${err.message}` } });
    }
});

module.exports = router;
