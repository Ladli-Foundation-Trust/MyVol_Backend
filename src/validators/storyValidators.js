const { z } = require('zod');

// Multipart field next to the "media" file. "" means no caption.
const createStory = z
    .strictObject({
        caption: z.string().trim().max(200, 'must be at most 200 characters').optional(),
    })
    .default({});

const storyParams = z.strictObject({ storyId: z.uuid('is not a valid story id') });

module.exports = { createStory, storyParams };
