// Instagram-style framing: turns the crop the user made in the app (fractions of the
// upright photo/video) into a pixel rectangle at EXACTLY the post's aspect ratio, inside
// the media. Used for photos (sharp) and videos (ffmpeg), so every item in a post comes
// out the same shape.
//
//   cropRect(srcW, srcH, ratio, crop?, { even? }) -> { left, top, width, height }
//
// crop = { x, y, w, h } (0..1) or null/undefined for the largest centred rectangle.
// The app sends a crop already at the ratio; rounding on its side (and old/odd clients)
// is corrected here by keeping the crop's centre and area. `even`: H.264 needs even sizes.

const cropRect = (srcW, srcH, ratio, crop, { even = false } = {}) => {
    let width;
    let height;
    let cx = srcW / 2;
    let cy = srcH / 2;

    if (crop) {
        const cw = crop.w * srcW;
        const ch = crop.h * srcH;
        width = Math.sqrt(cw * ch * ratio);
        height = width / ratio;
        cx = (crop.x + crop.w / 2) * srcW;
        cy = (crop.y + crop.h / 2) * srcH;
    } else {
        width = Math.min(srcW, srcH * ratio);
        height = width / ratio;
    }

    // Never larger than the media.
    const fit = Math.min(1, srcW / width, srcH / height);
    width *= fit;
    height *= fit;

    const round = (v) => (even ? Math.max(2, Math.floor(v / 2) * 2) : Math.max(1, Math.floor(v)));
    width = Math.min(round(width), even ? srcW - (srcW % 2) : srcW);
    height = Math.min(round(height), even ? srcH - (srcH % 2) : srcH);

    const clamp = (v, max) => Math.min(Math.max(0, Math.round(v)), max);
    return {
        left: clamp(cx - width / 2, srcW - width),
        top: clamp(cy - height / 2, srcH - height),
        width,
        height,
    };
};

module.exports = { cropRect };
