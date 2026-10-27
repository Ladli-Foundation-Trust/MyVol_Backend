const os = require('os');
const fs = require('fs');
const multer = require('multer');
const env = require('../config/env');
const AppError = require('../utils/appError');

// Avatar: kept in memory (small, goes straight to sharp), one file, no other fields.
// Limit errors are turned into 4xx by errorHandler.
const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MAX_AVATAR_MB * 1024 * 1024, files: 1, fields: 0 },
}).single('avatar');

// A post: up to 6 photos/videos in the "media" field plus the text fields. Written to
// the OS temp folder (videos are too big for memory) and deleted when the response
// ends, whatever happened. The per-file cap is the video limit; photos are checked
// against their own, smaller limit in postService.
const MAX_POST_MEDIA = 6;
const postMulter = multer({
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: {
        fileSize: Math.max(env.MAX_POST_VIDEO_MB, env.MAX_POST_IMAGE_MB) * 1024 * 1024,
        files: MAX_POST_MEDIA,
        fields: 10,
        fieldSize: 10 * 1024,
    },
}).array('media', MAX_POST_MEDIA);

// A story: one photo or video in "media" plus an optional caption. On disk, like posts.
const storyMulter = multer({
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: {
        fileSize: Math.max(env.MAX_POST_VIDEO_MB, env.MAX_POST_IMAGE_MB) * 1024 * 1024,
        files: 1,
        fields: 2,
        fieldSize: 2 * 1024,
    },
}).single('media');

// Runs on 'close', where a throw would crash the server, so it is defensive: after a
// multer error (e.g. a second file for a story) req.files/req.file can hold entries
// that were never written to disk (no path).
const removeTempFiles = (req) => {
    const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
    for (const file of [...files, req.file]) {
        if (typeof file?.path === 'string') fs.rm(file.path, { force: true }, () => {});
    }
};

const postUpload = (req, res, next) => {
    res.on('close', () => removeTempFiles(req));
    postMulter(req, res, next);
};

const storyUpload = (req, res, next) => {
    res.on('close', () => removeTempFiles(req));
    storyMulter(req, res, next);
};

const requireFile = (req, res, next) => {
    if (!req.file) {
        return next(new AppError('Attach an image in the "avatar" form field', 400, undefined, 'FILE_REQUIRED'));
    }
    next();
};

const requireMedia = (req, res, next) => {
    if (!req.file) {
        return next(new AppError('Attach a photo or video in the "media" form field', 400, undefined, 'FILE_REQUIRED'));
    }
    next();
};

module.exports = { avatarUpload, postUpload, storyUpload, requireFile, requireMedia, MAX_POST_MEDIA };
