const env = require('./src/config/env');
const app = require('./src/app');
const prisma = require('./src/lib/prisma');

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
    });

    const shutdown = (signal) => {
        console.log(`${signal} received, shutting down`);
        server.close(async () => {
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
