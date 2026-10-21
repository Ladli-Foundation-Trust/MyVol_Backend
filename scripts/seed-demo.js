// Demo data for trying the app locally: the app's volunteers (Priya, Aarav, Meera...)
// with avatars, follows, photo posts, reels, likes, comments and views. Everything
// goes through the real services, so files are processed exactly like uploads.
//
//   npm run db:seed:demo                          create the demo data (skips if it exists)
//   npm run db:seed:demo -- --reset               delete it first, then create it again
//   npm run db:seed:demo -- --follow <username>   also make your own account follow them,
//                                                 so their posts show in your home feed
//   npm run db:seed:demo -- --videos <folder>     use your own .mp4/.mov clips for the reels
//                                                 (otherwise ffmpeg generates test patterns)
//
// Demo accounts: <username>@demo.myvolapp.local, password Volunteer2026
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const env = require('../src/config/env');
const prisma = require('../src/lib/prisma');
const { FFMPEG } = require('../src/lib/videos');
const { hashPassword } = require('../src/utils/password');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const profiles = require('../src/services/profileService');
const follows = require('../src/services/followService');
const posts = require('../src/services/postService');
const comments = require('../src/services/commentService');

const DOMAIN = '@demo.myvolapp.local';
const PASSWORD = 'Volunteer2026';

const USERS = [
    { username: 'priya_sharma', name: 'Priya Sharma', bio: 'Community organizer · Mumbai', city: 'Mumbai', color: '#F05B83' },
    { username: 'aarav_mehta', name: 'Aarav Mehta', bio: 'Environment volunteer', city: 'Bengaluru', color: '#2E9E5B' },
    { username: 'meera_iyer', name: 'Meera Iyer', bio: 'Education & child rights advocate', city: 'Chennai', color: '#813287' },
    { username: 'rohan_gupta', name: 'Rohan Gupta', bio: 'Weekend volunteer, animal welfare', city: 'Hyderabad', color: '#E8912D' },
    { username: 'ananya_singh', name: 'Ananya Singh', bio: 'Health camps & first-aid drives', city: 'Kolkata', color: '#3A7BD5' },
];

// [author, title, description, category, beneficiaries, hours, ffmpeg source]
const REELS = [
    ['aarav_mehta', 'Tree Plantation Drive', 'Planted 50 saplings with local volunteers. Swipe for the before/after!', 'Environment', 50, 2, 'testsrc2=size=720x1280:rate=30'],
    ['ananya_singh', 'Rainwater Harvesting Workshop', 'Full walkthrough of the rooftop setup so other societies can copy it.', 'Environment', 12, 3, 'mandelbrot=size=720x1280:rate=30'],
    ['priya_sharma', 'Community Food Distribution', 'Meals for 120 families this weekend. Thank you, team!', 'Hunger & Poverty', 120, 4, 'life=size=720x1280:rate=15:mold=10:ratio=0.3:life_color=#F05B83:death_color=#1a1a1a'],
    ['rohan_gupta', 'Street Animal Feeding Drive', 'Feeding and first aid for 40 street dogs in our area.', 'Animal Welfare', 40, 2, 'cellauto=size=720x1280:rate=30:rule=110'],
    ['meera_iyer', 'School Science Fair Mentoring', 'Kids built water filters from scratch. So proud of them!', 'Education', 35, 5, 'smptehdbars=size=720x1280:rate=30'],
];

// [author, title, description, category, beneficiaries, hours, colour]
const PHOTO_POSTS = [
    ['priya_sharma', 'Child Rights Awareness Camp', 'Sessions with 60 parents on school enrolment and child safety.', 'Child Rights', 60, 3, '#F05B83'],
    ['ananya_singh', 'Free Health Camp', 'Blood pressure and sugar checks for 200 residents.', 'Health', 200, 6, '#3A7BD5'],
    ['meera_iyer', 'Looking for 5 more volunteers this Sunday', 'Teaching session at the community library, 10 am. DM me!', 'Education', 0, 0, null],
];

const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myvolapp-demo-'));

const makeVideo = (i, source) => {
    const file = path.join(tmp, `reel-${i}.mp4`);
    execFileSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', source,
        '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 110}`,
        '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ]);
    return file;
};

const makePhoto = async (i, color) => {
    const file = path.join(tmp, `photo-${i}.jpg`);
    await sharp({ create: { width: 1080, height: 1350, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
        .tint(color)
        .jpeg()
        .toFile(file);
    return file;
};

const asUpload = (file) => ({
    path: file,
    size: fs.statSync(file).size,
    mimetype: /\.(mp4|mov|m4v|webm)$/i.test(file) ? 'video/mp4' : 'image/jpeg',
});

const demoUsers = () => prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true, username: true } });

const reset = async () => {
    const users = await demoUsers();
    if (!users.length) return;
    await prisma.user.updateMany({
        where: { id: { in: users.map((u) => u.id) } },
        data: { status: 'PENDING_DELETION', deletionScheduledAt: new Date() },
    });
    await runAuthCleanup();
    console.log(`Removed ${users.length} demo users and their files.`);
};

const main = async () => {
    if (env.isProd) throw new Error('Refusing to seed demo data in production');
    if (args.includes('--reset')) await reset();
    if ((await demoUsers()).length) {
        console.log('Demo data already exists. Run with -- --reset to recreate it.');
        return;
    }

    // Users: verified, with an avatar and a city.
    const passwordHash = await hashPassword(PASSWORD);
    const ids = {};
    for (const u of USERS) {
        const user = await prisma.user.create({
            data: {
                email: `${u.username}${DOMAIN}`,
                username: u.username,
                name: u.name,
                bio: u.bio,
                passwordHash,
                dateOfBirth: new Date('1998-04-12'),
                emailVerifiedAt: new Date(),
                termsAcceptedAt: new Date(),
                profile: { create: { city: u.city, country: 'India', skills: ['Teamwork'], volunteeringTypes: ['Field'] } },
            },
        });
        ids[u.username] = user.id;
        const avatar = await sharp({ create: { width: 512, height: 512, channels: 3, background: u.color } }).png().toBuffer();
        await profiles.setAvatar(user.id, { buffer: avatar });
    }

    // Everyone follows everyone.
    for (const a of USERS) for (const b of USERS) if (a !== b) await follows.follow(ids[a.username], b.username);

    const extra = argValue('--follow');
    if (extra) {
        const me = await prisma.user.findUnique({ where: { username: extra.toLowerCase() }, select: { id: true } });
        if (!me) throw new Error(`No user called ${extra}`);
        for (const u of USERS) await follows.follow(me.id, u.username);
        console.log(`${extra} now follows the demo users.`);
    }

    // Reels: own clips if given, else generated patterns.
    const own = argValue('--videos');
    const clips = own ? fs.readdirSync(own).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).map((f) => path.join(own, f)) : [];
    const created = [];
    for (const [i, [author, title, description, category, beneficiaries, hours, source]] of REELS.entries()) {
        process.stdout.write(`  reel ${i + 1}/${REELS.length}: ${title}... `);
        const file = clips[i] ?? makeVideo(i, source);
        const post = await posts.createPost(ids[author], { title, description, category, beneficiaries, hours, location: `${USERS.find((u) => u.username === author).city}, India` }, [asUpload(file)]);
        created.push(post);
        console.log('ok');
    }

    for (const [i, [author, title, description, category, beneficiaries, hours, color]] of PHOTO_POSTS.entries()) {
        const files = color ? [asUpload(await makePhoto(i, color)), asUpload(await makePhoto(i + 10, '#ffffff'))] : [];
        created.push(await posts.createPost(ids[author], { title, description, category, beneficiaries, hours, location: `${USERS.find((u) => u.username === author).city}, India` }, files));
    }

    // A carousel mixing a photo and a video.
    created.push(
        await posts.createPost(
            ids.aarav_mehta,
            { title: 'Environment Cleanup', description: 'Riverbank cleanup: 30 bags of waste collected.', category: 'Environment', beneficiaries: 0, hours: 3, location: 'Bengaluru, India' },
            [asUpload(await makePhoto(20, '#2E9E5B')), asUpload(makeVideo(9, 'testsrc2=size=1280x720:rate=30'))],
        ),
    );

    // Some engagement so counters aren't all zero.
    const lines = ['Great initiative! 👏', 'Count me in next time', 'This is so inspiring', 'Which area was this in?'];
    for (const [i, post] of created.entries()) {
        const others = USERS.filter((u) => ids[u.username] !== post.author.id);
        for (const [j, u] of others.entries()) {
            if ((i + j) % 2 === 0) await posts.likePost(ids[u.username], post.id);
            if (post.media.some((m) => m.type === 'video')) await posts.recordView(ids[u.username], post.id, { watchMs: 4000 + j * 500 });
        }
        const commenter = others[i % others.length];
        const c = await comments.addComment(ids[commenter.username], post.id, { text: lines[i % lines.length] });
        await comments.addComment(post.author.id, post.id, { text: `Thank you, ${commenter.name.split(' ')[0]}!`, parentId: c.id });
    }

    console.log(`\nCreated ${USERS.length} demo users, ${created.length} posts (${REELS.length} reels).`);
    console.log(`Log in as any of: ${USERS.map((u) => u.username).join(', ')}  /  password: ${PASSWORD}`);
};

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(async () => {
        fs.rmSync(tmp, { recursive: true, force: true });
        await prisma.$disconnect();
    });
