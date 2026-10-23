const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const { protect } = require('../middleware/auth');
const { listQuery } = require('../validators/userValidators');
const schemas = require('../validators/searchValidators');
const search = require('../services/searchService');

const ok = (res, data) => res.json({ status: 'success', data });

// /api/v1/search/... The app's Search screen calls users and posts in parallel
// (its "Volunteers" and "Activities" tabs) and hashtags while typing "#".
const searchRouter = express.Router();
searchRouter.use(protect, limits.searchLimiter);

searchRouter.get('/users', validate({ query: schemas.userSearch }), async (req, res) => {
    const { q, ...page } = req.validatedQuery;
    ok(res, await search.searchUsers(req.user.id, q, page));
});

searchRouter.get('/posts', validate({ query: schemas.postSearch }), async (req, res) => {
    const { q, ...page } = req.validatedQuery;
    ok(res, await search.searchPosts(req.user.id, q, page));
});

searchRouter.get('/hashtags', validate({ query: schemas.hashtagSearch }), async (req, res) => {
    const { q, ...page } = req.validatedQuery;
    ok(res, await search.searchHashtags(q, page));
});

// /api/v1/hashtags/:tag/posts: a hashtag's page.
const hashtagRouter = express.Router();
hashtagRouter.use(protect);

hashtagRouter.get('/:tag/posts', validate({ params: schemas.hashtagParams, query: listQuery }), async (req, res) => {
    ok(res, await search.hashtagPosts(req.user.id, req.params.tag, req.validatedQuery));
});

module.exports = { searchRouter, hashtagRouter };
