const env = require('./src/config/env');
const app = require('./src/app');
const prisma = require('./src/lib/prisma');
const { runAuthCleanup } = require('./src/jobs/authCleanup');
const realtime = require('./src/lib/realtime');
const notifications = require('./src/services/notificationService');

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const cleanup = () =>
    runAuthCleanup()
        .then((result) => result && console.log('[auth-cleanup]', result))
        .catch((err) => console.error('[auth-cleanup] failed:', err.message));

const start = async () => {
    try {
        await prisma.$connect();
        console.log('Connected to PostgreSQL');
    } catch (err) {
        console.error('Could not connect to PostgreSQL:', err.message);
        process.exit(1);
    }

    const server = app.listen(env.PORT, () => {
        console.log(`MyVolApp API on http://localhost:${env.PORT}/api/v1 (${env.NODE_ENV})`);
        console.log(`Live notifications on ws://localhost:${env.PORT}${realtime.PATH}`);
    });
    // The WebSocket shares the HTTP port; 'ready' tells a new connection its badge count.
    const live = realtime.attach(server, { onReady: (user) => notifications.unreadCount(user.id) });

    cleanup();
    // unref: the timer alone must not keep the process alive during shutdown.
    const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

    const shutdown = (signal) => {
        console.log(`${signal} received, shutting down`);
        clearInterval(cleanupTimer);
        live.close(); // the apps reconnect to the next server
        server.close(async () => {
            await notifications.settle(); // let notifications already on their way finish
            await prisma.$disconnect();
            process.exit(0);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
};

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    process.exit(1);
});

start();
