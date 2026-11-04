// Demo data for trying the app locally: the app's volunteers (Priya, Aarav, Meera...)
// with avatars, follows, photo posts, reels, likes, comments and views. Everything
// goes through the real services, so files are processed exactly like uploads.
//
//   npm run db:seed:demo                          create the demo data (skips if it exists)
//   npm run db:seed:demo -- --reset               delete it first, then create it again
//   npm run db:seed:demo -- --follow <username>   also make your own account follow them,
//                                                 so their posts show in your home feed
//   npm run db:seed:demo -- --videos <folder>     use your own .mp4/.mov clips for the reels
//                                                 (otherwise the clips in demo-media/videos)
//
// Photos, portraits and clips come from demo-media/ (credits in demo-media/CREDITS.md).
// Demo accounts: <username>@demo.myvolapp.local, password Volunteer2026
const fs = require('fs');
const path = require('path');
const env = require('../src/config/env');
const prisma = require('../src/lib/prisma');
const media = require('../demo-media');
const { hashPassword } = require('../src/utils/password');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const profiles = require('../src/services/profileService');
const follows = require('../src/services/followService');
const posts = require('../src/services/postService');
const comments = require('../src/services/commentService');
const notifications = require('../src/services/notificationService');

const DOMAIN = '@demo.myvolapp.local';
const PASSWORD = 'Volunteer2026';

// `avatar` is a portrait in demo-media/avatars.
const USERS = [
    { username: 'priya_sharma', name: 'Priya Sharma', bio: 'Community organizer · Mumbai', city: 'Mumbai', avatar: 'priya' },
    { username: 'aarav_mehta', name: 'Aarav Mehta', bio: 'Environment volunteer', city: 'Bengaluru', avatar: 'aarav' },
    { username: 'meera_iyer', name: 'Meera Iyer', bio: 'Education & child rights advocate', city: 'Chennai', avatar: 'meera' },
    { username: 'rohan_gupta', name: 'Rohan Gupta', bio: 'Weekend volunteer, animal welfare', city: 'Hyderabad', avatar: 'rohan' },
    { username: 'ananya_singh', name: 'Ananya Singh', bio: 'Health camps & first-aid drives', city: 'Kolkata', avatar: 'ananya' },
];

// [author, title, description, category, beneficiaries, hours, clip in demo-media/videos]
const REELS = [
    ['aarav_mehta', 'Tree Plantation Drive', 'Planted 50 saplings with local volunteers. Swipe for the before/after!', 'Environment', 50, 2, 'tree_planting'],
    ['ananya_singh', 'Blood Donation & Health Camp', 'Free check-ups and a blood donation drive with the local samiti. 150 residents came by!', 'Health', 150, 5, 'health_camp'],
    ['priya_sharma', 'Community Food Distribution', 'Meals for 120 families this weekend. Thank you, team!', 'Hunger & Poverty', 120, 4, 'food_distribution'],
    ['rohan_gupta', 'Street Animal Feeding Drive', 'Feeding and first aid for 40 street dogs in our area.', 'Animal Welfare', 40, 2, 'animal_feeding'],
    ['meera_iyer', 'School Science Fair Mentoring', 'Kids built models from scratch for the science fair. So proud of them!', 'Education', 35, 5, 'kids_mentoring'],
];

// [author, title, description, category, beneficiaries, hours, photos in demo-media/photos]
const PHOTO_POSTS = [
    ['priya_sharma', 'Child Rights Awareness Camp', 'Sessions with 60 parents on school enrolment and child safety.', 'Child Rights', 60, 3, ['child_rights', 'cat_child_rights']],
    ['ananya_singh', 'Free Health Camp', 'Blood pressure and sugar checks for 200 residents.', 'Health', 200, 6, ['health_camp', 'cat_health']],
    ['rohan_gupta', 'Stray Dog Vaccination Drive', 'Helped the vet team vaccinate 45 street dogs.', 'Animal Welfare', 45, 4, ['animal_feeding']],
    ['meera_iyer', 'Evening Tutoring Classes', 'Maths and English for 25 children, every weekday at 6 pm.', 'Education', 25, 2, ['tutoring', 'cat_education']],
    ['aarav_mehta', 'Sapling Drive at the School', 'Students planted and adopted 30 saplings around their school.', 'Environment', 30, 3, ['sapling_drive', 'tree_planting']],
    ['meera_iyer', 'Looking for 5 more volunteers this Sunday', 'Teaching session at the community library, 10 am. DM me!', 'Education', 0, 0, []],
];

const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

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
        await profiles.setAvatar(user.id, media.avatar(u.avatar));
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

    // Reels: own clips if given, else the demo-media clips.
    const own = argValue('--videos');
    const clips = own ? fs.readdirSync(own).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).map((f) => path.join(own, f)) : [];
    const created = [];
    for (const [i, [author, title, description, category, beneficiaries, hours, clip]] of REELS.entries()) {
        process.stdout.write(`  reel ${i + 1}/${REELS.length}: ${title}... `);
        const file = clips[i] ? asUpload(clips[i]) : media.video(clip);
        const post = await posts.createPost(ids[author], { title, description, category, beneficiaries, hours, location: `${USERS.find((u) => u.username === author).city}, India` }, [file]);
        created.push(post);
        console.log('ok');
    }

    for (const [author, title, description, category, beneficiaries, hours, photos] of PHOTO_POSTS) {
        created.push(await posts.createPost(ids[author], { title, description, category, beneficiaries, hours, location: `${USERS.find((u) => u.username === author).city}, India` }, photos.map(media.photo)));
    }

    // A carousel mixing a photo and a video.
    created.push(
        await posts.createPost(
            ids.aarav_mehta,
            { title: 'Environment Cleanup', description: 'Riverbank cleanup: 30 bags of waste collected.', category: 'Environment', beneficiaries: 0, hours: 3, location: 'Bengaluru, India' },
            [media.photo('river_cleanup_1'), media.video('river_cleanup'), media.photo('river_cleanup_2')],
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

    // Notifications are written after each action; wait for them before disconnecting.
    await notifications.settle();
    console.log(`\nCreated ${USERS.length} demo users, ${created.length} posts (${REELS.length} reels).`);
    console.log(`Log in as any of: ${USERS.map((u) => u.username).join(', ')}  /  password: ${PASSWORD}`);
};

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
