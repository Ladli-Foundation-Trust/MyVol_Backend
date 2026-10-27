const express = require('express');

const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/posts', require('./postRoutes'));
router.use('/comments', require('./commentRoutes'));
router.use('/stories', require('./storyRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/settings', require('./settingsRoutes'));

const { searchRouter, hashtagRouter } = require('./searchRoutes');
router.use('/search', searchRouter);
router.use('/hashtags', hashtagRouter);
router.use('/reports', require('./reportRoutes'));
router.use('/admin', require('./adminRoutes'));

module.exports = router;
