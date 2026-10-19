const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const express = require('express');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const AppError = require('./utils/appError');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimit');
const healthRoutes = require('./routes/healthRoutes');
const apiRoutes = require('./routes');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
    cors({
        origin: (origin, cb) => {
            if (!origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
                return cb(null, true);
            }
            return cb(new AppError('Origin not allowed by CORS', 403));
        },
        credentials: true,
    }),
);
if (!env.isTest) app.use(morgan(env.isProd ? 'combined' : 'dev'));
app.use('/api', apiLimiter);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

app.use('/health', healthRoutes);
app.use('/api/v1', apiRoutes);

app.all('/{*splat}', (req, res, next) => {
    next(new AppError(`Can't find ${req.method} ${req.originalUrl} on this server`, 404));
});

app.use(errorHandler);

module.exports = app;
