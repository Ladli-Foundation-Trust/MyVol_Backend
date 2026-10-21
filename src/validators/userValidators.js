const { z } = require('zod');
const { fields } = require('./authValidators');

// Option lists match the app's Profile Details screen (MyVolApp src/data/profileDetailsContent.js).
const GENDERS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];
const QUALIFICATIONS = ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctorate'];
const PREFERRED_AREAS = [
    'Environmental Conservation',
    'Education',
    'Healthcare',
    'Animal Welfare',
    'Community Development',
    'Disaster Relief',
];
const AVAILABILITY = ['Weekdays', 'Weekends'];
const VOLUNTEERING_TYPES = ['Online', 'Field'];

// Free text: trimmed; "" or null clears the field.
const clearableText = (max) =>
    z
        .string()
        .trim()
        .max(max, `must be at most ${max} characters`)
        .nullable()
        .transform((v) => v || null);

const choice = (options) => z.enum(options, { error: `must be one of: ${options.join(', ')}` }).nullable();

// Duplicates are dropped, so ["Online", "Online"] is stored once.
const uniqueList = (item, max) =>
    z
        .array(item)
        .max(max, `can have at most ${max} items`)
        .transform((list) => [...new Set(list)]);

const updateMe = z
    .strictObject({
        name: fields.name,
        bio: clearableText(150),
        isPrivate: z.boolean(),
        dateOfBirth: fields.dateOfBirth,
        showPersonalDetails: z.boolean(),
        gender: choice(GENDERS),
        country: clearableText(60),
        state: clearableText(60),
        city: clearableText(60),
        qualification: choice(QUALIFICATIONS),
        fieldOfStudy: clearableText(80),
        skills: uniqueList(z.string().trim().min(1, 'cannot be empty').max(40), 20),
        preferredAreas: uniqueList(z.enum(PREFERRED_AREAS), PREFERRED_AREAS.length),
        availability: uniqueList(z.enum(AVAILABILITY), AVAILABILITY.length),
        volunteeringTypes: uniqueList(z.enum(VOLUNTEERING_TYPES), VOLUNTEERING_TYPES.length),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, 'send at least one field to update');

const changeUsername = z.strictObject({ username: fields.username });

// `:user` is a user id or a username (see socialGraph.findActiveUser).
const userParams = z.strictObject({ user: z.string().trim().min(1).max(64) });

const requestParams = z.strictObject({ userId: z.uuid('is not a valid user id') });

const listQuery = z.strictObject({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});

module.exports = { updateMe, changeUsername, userParams, requestParams, listQuery };
