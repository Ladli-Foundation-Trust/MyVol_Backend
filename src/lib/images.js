const sharp = require('sharp');
const AppError = require('../utils/appError');
const { cropRect } = require('./crop');

// Decoded by sharp rather than trusting the upload's file name or Content-Type.
// SVG is refused: it can carry scripts and external references.
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);
const MAX_INPUT_PIXELS = 40_000_000; // ~ a 48 MP photo; stops "decompression bomb" images
const AVATAR_SIZE = 512;
const POST_IMAGE_MAX_SIDE = 1440; // sharp on phones, ~150-400 KB as WebP

const invalidImage = () =>
    new AppError('Please upload a JPEG, PNG, WebP or HEIC image', 400, undefined, 'INVALID_IMAGE');

const assertImage = async (buffer) => {
    let format;
    try {
        ({ format } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata());
    } catch {
        throw invalidImage();
    }
    if (!ALLOWED_FORMATS.has(format)) throw invalidImage();
};

// Square 512 px WebP. rotate() applies the EXIF orientation before sharp drops all
// metadata, so phone photos come out upright and without GPS location in them.
const toAvatar = async (buffer) => {
    await assertImage(buffer);
    try {
        return await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
            .webp({ quality: 82 })
            .toBuffer();
    } catch {
        throw invalidImage();
    }
};

// Post photo: longest side at most 1440 px (never enlarged), upright and without
// metadata. With `frame` ({ ratio, crop }) it is first cut to the post's aspect ratio
// (lib/crop.js); without it, it keeps its own shape. Returns the size so the app can
// lay out the feed before the image loads.
const toPostImage = async (buffer, frame) => {
    await assertImage(buffer);
    try {
        let upright = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
        if (frame) {
            // The crop is in upright coordinates: EXIF orientations 5-8 swap width/height.
            const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
            const swap = (meta.orientation ?? 1) >= 5;
            const w = swap ? meta.height : meta.width;
            const h = swap ? meta.width : meta.height;
            // rotate() then extract() in one pipeline: sharp applies the rotation first.
            upright = upright.extract(cropRect(w, h, frame.ratio, frame.crop));
        }
        const { data, info } = await upright
            .resize(POST_IMAGE_MAX_SIDE, POST_IMAGE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer({ resolveWithObject: true });
        return { buffer: data, width: info.width, height: info.height };
    } catch {
        throw invalidImage();
    }
};

// Announcement picture: JPEG (not WebP), because Android shows it as the
// notification's big picture and JPEG is the format every phone's notification
// renderer accepts. At most 1200 px wide (FCM recommends ~2:1 and under 1 MB).
const ANNOUNCEMENT_MAX_WIDTH = 1200;
const toAnnouncementImage = async (buffer) => {
    await assertImage(buffer);
    try {
        const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize(ANNOUNCEMENT_MAX_WIDTH, ANNOUNCEMENT_MAX_WIDTH, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' }) // transparent PNGs get a white background, not black
            .jpeg({ quality: 82, mozjpeg: true })
            .toBuffer({ resolveWithObject: true });
        return { buffer: data, width: info.width, height: info.height };
    } catch {
        throw invalidImage();
    }
};

module.exports = { toAvatar, toPostImage, toAnnouncementImage };
