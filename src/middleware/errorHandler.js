const AppError = require('../utils/appError');
const { isProd } = require('../config/env');


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
    if (err.name === 'MulterError') {
        error =
            err.code === 'LIMIT_FILE_SIZE'
                ? new AppError('That file is too large', 413, undefined, 'FILE_TOO_LARGE')
                : ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(err.code)
                  ? new AppError('Too many files, or a file in the wrong field (use "media", at most 6)', 400, undefined, 'INVALID_UPLOAD')
                  : new AppError(`Upload rejected: ${err.message}`, 400, undefined, 'INVALID_UPLOAD');
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
        error = new AppError('Invalid token. Please log in again', 401, undefined, 'TOKEN_INVALID');
    }
    // Clients refresh on TOKEN_EXPIRED and only log the user out on other 401 codes.
    if (err.name === 'TokenExpiredError') {
        error = new AppError('Your token has expired', 401, undefined, 'TOKEN_EXPIRED');
    }

    const statusCode = error.statusCode || 500;
    const operational = error.isOperational === true;

    if (!operational) console.error(err);

    const body = {
        status: error.status || 'error',
        message: operational || !isProd ? error.message : 'Something went wrong',
    };
    if (operational && error.code) body.code = error.code;
    if (error.details) body.details = error.details;
    if (!isProd) body.stack = err.stack;

    res.status(statusCode).json(body);
};
