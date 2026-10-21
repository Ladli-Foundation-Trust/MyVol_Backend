const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { path: FFPROBE } = require('@ffprobe-installer/ffprobe');
const storage = require('../src/lib/storage');
const { FFMPEG } = require('../src/lib/videos');
const { api, prisma, resetDb, signup, bearer } = require('./helpers');

const POSTS = '/api/v1/posts';

// Test clips made with ffmpeg's built-in generators (no binary fixtures in the repo).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myvolapp-video-test-'));
const clip = (name, args) => {
    const file = path.join(dir, name);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
    return file;
};
let H264, MPEG4, LONG, FAKE;

const probe = (file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
const fileOf = (url) => path.join(storage.ROOT, url.split('/uploads/')[1]);

before(async () => {
    await resetDb();
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440'];
    // Vertical H.264/AAC phone-style clip with a GPS tag: should be copied (fast path) and lose the tag.
    H264 = clip('phone.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', ...tone, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', 'location=+12.9716+077.5946/']);
    // 1080p MPEG-4 Part 2: must be transcoded to 720p H.264.
    MPEG4 = clip('old.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=25', '-t', '1', '-c:v', 'mpeg4']);
    LONG = clip('long.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=160x284:rate=10', '-t', '7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    FAKE = path.join(dir, 'fake.mp4');
    fs.writeFileSync(FAKE, 'definitely not a video');
});
after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await prisma.$disconnect();
});

const newUser = async () => {
    const { user, accessToken } = await signup();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return { id: user.id, username: user.username, auth: bearer(accessToken) };
};

const uploadPost = (who, files, fields = {}) => {
    let req = api().post(POSTS).set(who.auth).field('title', fields.title ?? 'Clip').field('category', fields.category ?? 'Environment');
    for (const file of files) req = req.attach('media', file);
    return req;
};

describe('video posts', () => {
    it('turns a single video into a reel: MP4 + WebP cover, duration, metadata removed', async () => {
        const me = await newUser();
        const res = await uploadPost(me, [H264]);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const { post } = res.body.data;
        assert.equal(post.isReel, true);
        assert.equal(post.viewsCount, 0);

        const [video] = post.media;
        assert.equal(video.type, 'video');
        assert.match(video.url, /\.mp4$/);
        assert.match(video.thumbnailUrl, /\.webp$/);
        assert.deepEqual([video.width, video.height], [360, 640]);
        assert.ok(video.durationMs >= 1900 && video.durationMs <= 2200, String(video.durationMs));

        const out = probe(fileOf(video.url));
        assert.equal(out.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
        assert.equal(out.format.tags?.location, undefined, 'GPS location must be stripped');
        assert.ok(fs.existsSync(fileOf(video.thumbnailUrl)));

        // Served with range support so players can seek.
        const partial = await api().get(new URL(video.url).pathname).set('Range', 'bytes=0-99');
        assert.equal(partial.status, 206);
        assert.equal(partial.headers['content-type'], 'video/mp4');
    });

    it('transcodes other codecs to 720p H.264', async () => {
        const me = await newUser();
        const res = await uploadPost(me, [MPEG4]);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const [video] = res.body.data.post.media;
        assert.deepEqual([video.width, video.height], [1280, 720]);
        assert.equal(probe(fileOf(video.url)).streams[0].codec_name, 'h264');
    });

    it('mixes photos and videos in one post (not a reel)', async () => {
        const me = await newUser();
        const photo = path.join(__dirname, '..', 'postman', 'fixtures', 'avatar.jpg');
        const files = fs.existsSync(photo) ? [photo, H264] : [H264, H264];
        const res = await uploadPost(me, files);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.data.post.isReel, false);
        assert.equal(res.body.data.post.media.length, 2);
    });

    it('rejects fake and too-long videos, leaving no files behind', async () => {
        const me = await newUser();
        const before = fs.existsSync(path.join(storage.ROOT, 'posts')) ? fs.readdirSync(path.join(storage.ROOT, 'posts')).length : 0;

        const fake = await uploadPost(me, [FAKE]);
        assert.equal(fake.status, 400);
        assert.equal(fake.body.code, 'INVALID_VIDEO');

        const long = await uploadPost(me, [H264, LONG]); // first one is fine, second fails
        assert.equal(long.status, 400);
        assert.equal(long.body.code, 'VIDEO_TOO_LONG');

        const afterCount = fs.readdirSync(path.join(storage.ROOT, 'posts')).length;
        assert.equal(afterCount, before, 'files of a failed post are cleaned up');
    });

    it('deleting a video post removes the video and its cover', async () => {
        const me = await newUser();
        const { post } = (await uploadPost(me, [H264])).body.data;
        await api().delete(`${POSTS}/${post.id}`).set(me.auth);
        assert.equal(fs.existsSync(fileOf(post.media[0].url)), false);
        assert.equal(fs.existsSync(fileOf(post.media[0].thumbnailUrl)), false);
    });
});

describe('reels', () => {
    it('lists visible single-video posts, newest first', async () => {
        const viewer = await newUser();
        const author = await newUser();
        const hidden = await newUser();
        await api().patch('/api/v1/users/me').set(hidden.auth).send({ isPrivate: true });

        const r1 = (await uploadPost(author, [H264], { title: 'Reel 1' })).body.data.post;
        await api().post(POSTS).set(author.auth).send({ title: 'Text', category: 'Health', description: 'not a reel' });
        await uploadPost(hidden, [H264], { title: 'Private reel' });
        const r2 = (await uploadPost(author, [H264], { title: 'Reel 2' })).body.data.post;

        const res = await api().get(`${POSTS}/reels`).set(viewer.auth);
        assert.equal(res.status, 200);
        const ids = res.body.data.posts.map((p) => p.id);
        assert.deepEqual(ids.slice(0, 2), [r2.id, r1.id]);
        assert.ok(res.body.data.posts.every((p) => p.isReel));
        assert.ok(!res.body.data.posts.some((p) => p.author.id === hidden.id));
    });

    it('counts one view per viewer, adds watch time, ignores the author', async () => {
        const author = await newUser();
        const a = await newUser();
        const b = await newUser();
        const { post } = (await uploadPost(author, [H264])).body.data;
        const view = (who, watchMs) => api().post(`${POSTS}/${post.id}/view`).set(who.auth).send({ watchMs });

        assert.deepEqual((await view(a, 1500)).body.data, { viewsCount: 1 });
        assert.deepEqual((await view(a, 2000)).body.data, { viewsCount: 1 });
        assert.deepEqual((await view(b, 500)).body.data, { viewsCount: 2 });
        assert.deepEqual((await view(author, 2000)).body.data, { viewsCount: 2 });

        const row = await prisma.postView.findUnique({ where: { userId_postId: { userId: a.id, postId: post.id } } });
        assert.deepEqual([row.plays, row.watchMs], [2, 3500]);

        const text = (await api().post(POSTS).set(author.auth).send({ title: 'T', category: 'Health', description: 'x' })).body.data.post;
        assert.equal((await api().post(`${POSTS}/${text.id}/view`).set(a.auth).send({})).body.code, 'NOT_A_VIDEO');
    });
});
