const AppError = require('../utils/appError');
const { isProd } = require('../config/env');

// Body shape: { status, message, details? } — the app's client.js reads `message`.

const fromPrisma = (err) => {
    switch (err.code) {
        case 'P2002': {
            const target = err.meta?.target;
            const fields = Array.isArray(target) ? target.join(', ') : target || 'field';
            return new AppError(`${fields} already in use`, 409);
        }
        case 'P2025':
            return new AppError('Record not found', 404);
        case 'P2003':
            return new AppError('Related record does not exist', 400);
        default:
            return null;
    }
};

module.exports = (err, req, res, next) => {
    let error = err;

    if (err.name === 'PrismaClientKnownRequestError') error = fromPrisma(err) || err;
    if (err.type === 'entity.parse.failed') error = new AppError('Malformed JSON body', 400);
    if (err.name === 'JsonWebTokenError') error = new AppError('Invalid token. Please log in again', 401);
    if (err.name === 'TokenExpiredError') error = new AppError('Your token has expired. Please log in again', 401);

    const statusCode = error.statusCode || 500;
    const operational = error.isOperational === true;

    if (!operational) console.error(err);

    const body = {
        status: error.status || 'error',
        message: operational || !isProd ? error.message : 'Something went wrong',
    };
    if (error.details) body.details = error.details;
    if (!isProd) body.stack = err.stack;

    res.status(statusCode).json(body);
};
