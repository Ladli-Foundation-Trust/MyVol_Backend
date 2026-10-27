const prisma = require('../lib/prisma');
const settings = require('./settingsService');
const { settlePendingRequests } = require('./followService');

// PATCH /settings. Lives apart from settingsService because changing who can follow has
// side effects in followService (which itself reads settings): an account that stops
// needing approval lets everyone waiting in, like Instagram going public.

const policyOf = async (tx, userId) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { isPrivate: true, settings: { select: { data: true } } } });
    return { isPrivate: user.isPrivate, whoCanFollow: user.settings?.data?.whoCanFollow ?? settings.DEFAULTS.whoCanFollow };
};

const updateSettings = async (userId, changes) => {
    const { columns, json } = settings.splitChanges(changes);
    await prisma.$transaction(async (tx) => {
        const before = await policyOf(tx, userId);
        if (Object.keys(columns).length) await tx.user.update({ where: { id: userId }, data: columns, select: { id: true } });
        await settings.writeJson(tx, userId, json);
        await settlePendingRequests(tx, userId, before, await policyOf(tx, userId));
    });
    return settings.getSettings(userId);
};

module.exports = { updateSettings };
