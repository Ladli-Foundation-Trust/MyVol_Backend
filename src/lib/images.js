const sharp = require('sharp');
const AppError = require('../utils/appError');

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

// Post photo: keeps its aspect ratio, longest side at most 1440 px (never enlarged),
// upright and without metadata. Returns the size so the app can lay out the feed
// before the image loads.
const toPostImage = async (buffer) => {
    await assertImage(buffer);
    try {
        const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize(POST_IMAGE_MAX_SIDE, POST_IMAGE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer({ resolveWithObject: true });
        return { buffer: data, width: info.width, height: info.height };
    } catch {
        throw invalidImage();
    }
};

module.exports = { toAvatar, toPostImage };
