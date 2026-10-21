const profiles = require('../services/profileService');
const follows = require('../services/followService');

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

exports.removeFollower = async (req, res) => {
    await follows.removeFollower(req.user.id, req.params.user);
    res.json({ status: 'success', message: 'Follower removed' });
};
