const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { verifyAccessToken } = require('../utils/tokens');

const protect = async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return next(new AppError('You are not logged in', 401));
    }

    const payload = verifyAccessToken(token); // throws → 401 via errorHandler

    
    const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, tokenVersion: true },
    });
    if (!user) return next(new AppError('The user for this token no longer exists', 401));

    if (payload.ver !== user.tokenVersion) {
        return next(new AppError('Your session has ended. Please log in again', 401));
    }

    req.user = { id: user.id, role: user.role };
    next();
};

const restrictTo =
    (...roles) =>
    (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return next(new AppError('You do not have permission to perform this action', 403));
        }
        next();
    };

module.exports = { protect, restrictTo };
