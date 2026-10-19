// `code` is a stable machine-readable reason (e.g. TOKEN_EXPIRED) so clients can
// branch without parsing `message`, which is for humans and may change.
class AppError extends Error {
    constructor(message, statusCode, details, code) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;
        if (details) this.details = details;
        if (code) this.code = code;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;
