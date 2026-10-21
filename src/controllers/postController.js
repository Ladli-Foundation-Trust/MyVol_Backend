const posts = require('../services/postService');
const comments = require('../services/commentService');

const ok = (res, data, statusCode = 200) => res.status(statusCode).json({ status: 'success', data });

// ---------- posts ----------

exports.create = async (req, res) => ok(res, { post: await posts.createPost(req.user.id, req.body, req.files) }, 201);

exports.get = async (req, res) => ok(res, { post: await posts.getPost(req.user.id, req.params.postId) });

exports.update = async (req, res) => ok(res, { post: await posts.updatePost(req.user.id, req.params.postId, req.body) });

exports.remove = async (req, res) => {
    await posts.deletePost(req.user.id, req.params.postId);
    res.json({ status: 'success', message: 'Post deleted' });
};

exports.feed = async (req, res) => ok(res, await posts.homeFeed(req.user.id, req.validatedQuery));

exports.explore = async (req, res) => {
    const { category, ...query } = req.validatedQuery;
    ok(res, await posts.exploreFeed(req.user.id, { ...query, categories: category }));
};

exports.reels = async (req, res) => ok(res, await posts.reelsFeed(req.user.id, req.validatedQuery));

exports.view = async (req, res) => ok(res, await posts.recordView(req.user.id, req.params.postId, req.body));

exports.saved = async (req, res) => ok(res, await posts.savedPosts(req.user.id, req.validatedQuery));

exports.userPosts = async (req, res) => ok(res, await posts.userPosts(req.user.id, req.params.user, req.validatedQuery));

exports.like = async (req, res) => ok(res, await posts.likePost(req.user.id, req.params.postId));
exports.unlike = async (req, res) => ok(res, await posts.unlikePost(req.user.id, req.params.postId));
exports.likes = async (req, res) => ok(res, await posts.listLikes(req.user.id, req.params.postId, req.validatedQuery));
exports.save = async (req, res) => ok(res, await posts.savePost(req.user.id, req.params.postId));
exports.unsave = async (req, res) => ok(res, await posts.unsavePost(req.user.id, req.params.postId));
exports.share = async (req, res) => ok(res, await posts.sharePost(req.user.id, req.params.postId));

// ---------- comments ----------

exports.comments = async (req, res) => ok(res, await comments.listComments(req.user.id, req.params.postId, req.validatedQuery));

exports.addComment = async (req, res) => {
    ok(res, { comment: await comments.addComment(req.user.id, req.params.postId, req.body) }, 201);
};

exports.replies = async (req, res) => ok(res, await comments.listReplies(req.user.id, req.params.commentId, req.validatedQuery));

exports.deleteComment = async (req, res) => {
    await comments.deleteComment(req.user.id, req.params.commentId);
    res.json({ status: 'success', message: 'Comment deleted' });
};

exports.likeComment = async (req, res) => ok(res, await comments.likeComment(req.user.id, req.params.commentId));
exports.unlikeComment = async (req, res) => ok(res, await comments.unlikeComment(req.user.id, req.params.commentId));
