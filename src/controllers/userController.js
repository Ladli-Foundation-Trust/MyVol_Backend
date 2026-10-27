const profiles = require('../services/profileService');
const follows = require('../services/followService');
const blocks = require('../services/blockService');
const impact = require('../services/impactService');
const stories = require('../services/storyService');
const suggestions = require('../services/suggestionService');
const exporter = require('../services/exportService');

const ok = (res, data) => res.json({ status: 'success', data });

const ctx = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

// ---------- me ----------

exports.getMe = async (req, res) => ok(res, { profile: await profiles.getMe(req.user.id) });

exports.updateMe = async (req, res) => ok(res, { profile: await profiles.updateMe(req.user.id, req.body) });

exports.changeUsername = async (req, res) => {
    ok(res, { profile: await profiles.changeUsername(req.user.id, req.body, ctx(req)) });
};

exports.setAvatar = async (req, res) => ok(res, await profiles.setAvatar(req.user.id, req.file));

exports.removeAvatar = async (req, res) => {
    await profiles.removeAvatar(req.user.id);
    ok(res, { avatarUrl: null });
};

exports.listRequests = async (req, res) => ok(res, await follows.listRequests(req.user.id, req.validatedQuery));

exports.acceptRequest = async (req, res) => {
    await follows.acceptRequest(req.user.id, req.params.userId);
    res.json({ status: 'success', message: 'Follow request accepted' });
};

exports.declineRequest = async (req, res) => {
    await follows.declineRequest(req.user.id, req.params.userId);
    res.json({ status: 'success', message: 'Follow request declined' });
};

// ---------- other users ----------

exports.getProfile = async (req, res) => ok(res, { profile: await profiles.getProfile(req.user.id, req.params.user) });

exports.followers = async (req, res) => {
    ok(res, await follows.listFollows(req.user.id, req.params.user, 'followers', req.validatedQuery));
};

exports.following = async (req, res) => {
    ok(res, await follows.listFollows(req.user.id, req.params.user, 'following', req.validatedQuery));
};

exports.follow = async (req, res) => ok(res, await follows.follow(req.user.id, req.params.user));

exports.unfollow = async (req, res) => ok(res, await follows.unfollow(req.user.id, req.params.user));

// ---------- impact & medals ----------

exports.myImpact = async (req, res) => ok(res, await impact.getMyImpact(req.user.id));
exports.impact = async (req, res) => ok(res, await impact.getImpact(req.user.id, req.params.user));

// ---------- block & mute ----------

exports.block = async (req, res) => ok(res, await blocks.block(req.user.id, req.params.user));
exports.unblock = async (req, res) => ok(res, await blocks.unblock(req.user.id, req.params.user));
exports.mute = async (req, res) => ok(res, await blocks.mute(req.user.id, req.params.user));
exports.unmute = async (req, res) => ok(res, await blocks.unmute(req.user.id, req.params.user));
exports.listBlocked = async (req, res) => ok(res, await blocks.listBlocked(req.user.id, req.validatedQuery));
exports.listMuted = async (req, res) => ok(res, await blocks.listMuted(req.user.id, req.validatedQuery));

// ---------- suggestions, stories, export ----------

exports.suggestions = async (req, res) => ok(res, await suggestions.listSuggestions(req.user.id, req.validatedQuery));
exports.dismissSuggestion = async (req, res) => ok(res, await suggestions.dismiss(req.user.id, req.params.userId));
exports.stories = async (req, res) => ok(res, await stories.userStories(req.user.id, req.params.user));

// A JSON file download ("Download your information").
exports.exportData = async (req, res) => {
    const data = await exporter.exportData(req.user, req.body, ctx(req));
    const date = data.exportedAt.slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="myvolapp-${data.account.username}-${date}.json"`);
    res.set('Cache-Control', 'no-store');
    ok(res, data);
};

exports.removeFollower = async (req, res) => {
    await follows.removeFollower(req.user.id, req.params.user);
    res.json({ status: 'success', message: 'Follower removed' });
};
