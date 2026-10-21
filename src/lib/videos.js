const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const sharp = require('sharp');
const FFMPEG = require('ffmpeg-static');
const { path: FFPROBE } = require('@ffprobe-installer/ffprobe');
const env = require('../config/env');
const AppError = require('../utils/appError');

// Local video processing with bundled ffmpeg/ffprobe (no system install needed).
// Every upload becomes an MP4 that plays on any phone and starts streaming before it
// has fully downloaded (+faststart). When a cloud video service (Mux, Cloudinary,
// MediaConvert...) takes over, this file and lib/storage.js are what change.

const MAX_SIDE = 1920; // copy as-is up to 1080p; anything bigger is scaled down
const TARGET_SHORT_SIDE = 720; // transcodes come out at 720p
const THUMB_MAX_SIDE = 720;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

const invalidVideo = () => new AppError('Please upload an MP4, MOV or WebM video', 400, undefined, 'INVALID_VIDEO');

const run = (bin, args, { encoding = 'utf8' } = {}) =>
    new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding, windowsHide: true }, (err, stdout, stderr) =>
            err ? reject(Object.assign(err, { stderr: String(stderr).slice(-2000) })) : resolve(stdout),
        );
    });

// Transcoding is CPU-heavy: run one at a time so a few uploads can't freeze the API.
let queue = Promise.resolve();
const oneAtATime = (task) => {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
};

const probe = async (file) => {
    let info;
    try {
        info = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
    } catch {
        throw invalidVideo();
    }
    const video = info.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const audio = info.streams?.find((s) => s.codec_type === 'audio');
    const durationMs = Math.round(Number(info.format?.duration ?? video?.duration ?? 0) * 1000);
    if (!video || !durationMs) throw invalidVideo();

    const rotation = Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
    return { video, audio, durationMs, rotation };
};

const canCopy = ({ video, audio, rotation }) =>
    video.codec_name === 'h264' &&
    video.pix_fmt === 'yuv420p' &&
    rotation === 0 &&
    Math.max(video.width, video.height) <= MAX_SIDE &&
    (!audio || audio.codec_name === 'aac');

// Short side 720 px, keeping the aspect ratio (-2 = even number, as H.264 needs).
const SCALE = `scale='if(gt(iw,ih),-2,min(${TARGET_SHORT_SIDE},iw))':'if(gt(iw,ih),min(${TARGET_SHORT_SIDE},ih),-2)'`;

// Returns { buffer, thumbnail, width, height, durationMs } for a video on disk.
// -map_metadata -1 drops metadata such as the GPS location phones embed.
const processVideo = (inputPath) =>
    oneAtATime(async () => {
        const source = await probe(inputPath);
        if (source.durationMs > env.MAX_VIDEO_SECONDS * 1000) {
            throw new AppError(`Videos can be at most ${env.MAX_VIDEO_SECONDS} seconds long`, 400, undefined, 'VIDEO_TOO_LONG');
        }

        const out = path.join(os.tmpdir(), `myvolapp-${crypto.randomUUID()}.mp4`);
        const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1'];
        const encode = canCopy(source)
            ? ['-c', 'copy']
            : ['-vf', SCALE, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'];

        try {
            await run(FFMPEG, [...common, ...encode, '-movflags', '+faststart', out]);
            const result = await probe(out);
            const at = Math.min(1, result.durationMs / 2000).toFixed(2);
            const frame = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', at, '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], {
                encoding: 'buffer',
            });
            const thumbnail = await sharp(frame)
                .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 75 })
                .toBuffer();

            return {
                buffer: await fs.readFile(out),
                thumbnail,
                width: result.video.width,
                height: result.video.height,
                durationMs: result.durationMs,
            };
        } catch (err) {
            if (err instanceof AppError) throw err;
            console.error('[video] processing failed:', err.stderr || err.message);
            throw invalidVideo();
        } finally {
            await fs.rm(out, { force: true });
        }
    });

module.exports = { processVideo, FFMPEG };
