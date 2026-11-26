const env = require('./src/config/env');
const app = require('./src/app');
const prisma = require('./src/lib/prisma');
const { runAuthCleanup } = require('./src/jobs/authCleanup');
const realtime = require('./src/lib/realtime');
const notifications = require('./src/services/notificationService');

const announcements = require('./src/services/announcementService');

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ANNOUNCEMENT_CHECK_MS = 60 * 1000;

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
        console.log(`Closed-app notifications (FCM): ${require('./src/services/pushService').describe()}`);
    });
    // Longer than the 60 s idle timeout of proxies in front of us (nginx, load balancers,
    // the admin panel's rewrites), so they never reuse a socket Node has just closed
    // (that shows up as random ECONNRESET / 502s). headersTimeout must be larger still.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    // The WebSocket shares the HTTP port; 'ready' tells a new connection its badge count.
    const live = realtime.attach(server, { onReady: (user) => notifications.unreadCount(user.id) });

    cleanup();
    // unref: the timer alone must not keep the process alive during shutdown.
    const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();
    // Scheduled announcements go out within a minute of their time (D84).
    let ticks = 0;
    const announcementTimer = setInterval(() => {
        announcements.sendDue().catch((err) => console.error('[announcements] scheduler failed:', err.message));
        // Hourly: pictures uploaded for announcements that were never written.
        ticks += 1;
        if (ticks % 60 === 0) announcements.removeOrphanImages().catch((err) => console.error('[announcements] image cleanup failed:', err.message));
    }, ANNOUNCEMENT_CHECK_MS).unref();

    let stopping = false;
    const shutdown = (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`${signal} received, shutting down`);
        // A long upload or a stuck keep-alive must not hold the old container forever.
        setTimeout(() => {
            console.error('Shutdown took over 15 s; exiting anyway');
            process.exit(1);
        }, 15_000).unref();
        server.closeIdleConnections?.();
        clearInterval(cleanupTimer);
        clearInterval(announcementTimer);
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
