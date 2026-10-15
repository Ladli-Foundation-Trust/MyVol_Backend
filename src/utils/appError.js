class AppError extends Error {
    constructor(message, statusCode, details) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;
        if (details) this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;
