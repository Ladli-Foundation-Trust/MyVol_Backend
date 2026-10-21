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

const removeTempFiles = (req) => {
    for (const file of req.files ?? []) fs.rm(file.path, { force: true }, () => {});
};

const postUpload = (req, res, next) => {
    res.on('close', () => removeTempFiles(req));
    postMulter(req, res, next);
};

const requireFile = (req, res, next) => {
    if (!req.file) {
        return next(new AppError('Attach an image in the "avatar" form field', 400, undefined, 'FILE_REQUIRED'));
    }
    next();
};

module.exports = { avatarUpload, postUpload, requireFile, MAX_POST_MEDIA };
