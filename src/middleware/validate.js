const AppError = require('../utils/appError');

// Usage: router.post('/', validate({ body: schema, query: schema, params: schema }), handler)
// Parsed (coerced/defaulted) values replace the originals; query goes to req.validatedQuery
// because req.query is a read-only getter in Express 5.
const validate = (schemas) => (req, res, next) => {
    for (const key of ['params', 'query', 'body']) {
        if (!schemas[key]) continue;
        const result = schemas[key].safeParse(req[key]);
        if (!result.success) {
            const details = result.error.issues.map((i) => ({
                field: i.path.join('.'),
                message: i.message,
            }));
            const first = details[0];
            const message = first.field ? `${first.field}: ${first.message}` : first.message;
            return next(new AppError(message, 400, details));
        }
        if (key === 'query') req.validatedQuery = result.data;
        else req[key] = result.data;
    }
    next();
};

module.exports = validate;
