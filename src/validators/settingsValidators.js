const { z } = require('zod');
const { OPTIONS, DEFAULTS } = require('../services/settingsService');

// PATCH /settings: any subset of the app's keys (settingsService.DEFAULTS). Choice keys
// accept only their options, every other key a boolean. Unknown keys are refused.
const field = (key) =>
    OPTIONS[key] ? z.enum(OPTIONS[key], { error: `must be one of: ${OPTIONS[key].join(', ')}` }) : z.boolean({ error: 'must be true or false' });

const updateSettings = z
    .strictObject(Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, field(key)])))
    .partial()
    .refine((d) => Object.keys(d).length > 0, 'send at least one setting to update');

module.exports = { updateSettings };
