// Real photos and clips for the seed scripts (seed-demo, seed-e2e), so a demo shows
// people volunteering instead of colour blocks and test patterns. All openly licensed;
// creators and licences are in CREDITS.md. Swap in the foundation's own media when
// it's available: keep the file names and the seeds pick them up.
//
// The services only read these files (multer's temp-file cleanup is in the upload
// middleware, which seeds don't go through), so they are passed as-is.
const fs = require('fs');
const path = require('path');

const file = (dir, name, ext, mimetype) => {
    const p = path.join(__dirname, dir, `${name}.${ext}`);
    if (!fs.existsSync(p)) throw new Error(`Missing demo media: ${dir}/${name}.${ext}`);
    return { path: p, size: fs.statSync(p).size, mimetype };
};

// An upload-shaped file for postService.createPost / storyService.createStory.
const photo = (name) => file('photos', name, 'jpg', 'image/jpeg');
const video = (name) => file('videos', name, 'mp4', 'video/mp4');

// profileService.setAvatar takes a buffer. null when there is no portrait for that name.
const avatar = (name) => {
    const p = path.join(__dirname, 'avatars', `${name}.jpg`);
    return fs.existsSync(p) ? { buffer: fs.readFileSync(p) } : null;
};

module.exports = { photo, video, avatar };
