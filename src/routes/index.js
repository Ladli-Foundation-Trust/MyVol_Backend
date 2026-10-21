const express = require('express');

const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/posts', require('./postRoutes'));
router.use('/comments', require('./commentRoutes'));

module.exports = router;
