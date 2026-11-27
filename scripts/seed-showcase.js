// Showcase data for demoing the app to people outside the team: one main account,
// aarav_mehta, whose every screen has something real on it, in a community of 11
// volunteers with faces, photos, reels, stories, reactions, comments, a 5-level ripple
// and every kind of notification. No test-looking content (no "pm_", "e2e_", rejected or
// reported posts), so run it on its OWN database (.env.demo, see README "Demo database").
//
//   npm run demo:seed              create everything (refuses if the data exists)
//   npm run demo:seed -- --reset   delete the showcase accounts first, then create them
//   npm run demo:seed -- --stories re-post today's stories only (stories expire after 24 h)
//
// Log in as aarav_mehta / Volunteer@2026 (every account uses that password).
// Emails are <username>@showcase.myvol.local, so no email is ever really sent.
const env = require('../src/config/env');
const prisma = require('../src/lib/prisma');
const notifications = require('../src/services/notificationService');
const { photo, video, avatar } = require('../demo-media');
const { hashPassword } = require('../src/utils/password');
const { runAuthCleanup } = require('../src/jobs/authCleanup');
const profiles = require('../src/services/profileService');
const follows = require('../src/services/followService');
const posts = require('../src/services/postService');
const comments = require('../src/services/commentService');
const stories = require('../src/services/storyService');
const moderation = require('../src/services/moderationService');
const ripple = require('../src/services/rippleService');
const announcements = require('../src/services/announcementService');
const accountSettings = require('../src/services/accountSettingsService');

const DOMAIN = '@showcase.myvol.local';
const PASSWORD = 'Volunteer@2026';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ME = 'aarav_mehta';

// [username, name, city, state, bio, portrait, profile fields]
const USERS = [
    [ME, 'Aarav Mehta', 'Mumbai', 'Maharashtra', 'Environment volunteer · planting one tree at a time · weekend tutor', 'aarav',
        { preferredAreas: ['Environmental Conservation', 'Education'], skills: ['Teamwork', 'Public speaking', 'Driving'], availability: ['Weekends'], volunteeringTypes: ['Field', 'Online'], gender: 'Male', qualification: "Bachelor's Degree", showPersonalDetails: true }],
    ['priya_sharma', 'Priya Sharma', 'Thane', 'Maharashtra', 'Community organiser · food drives & child rights', 'priya', { preferredAreas: ['Community Development', 'Education'] }],
    ['ananya_singh', 'Ananya Singh', 'Kolkata', 'West Bengal', 'Doctor in training · health camps & first aid', 'ananya', { preferredAreas: ['Healthcare'] }],
    ['meera_iyer', 'Meera Iyer', 'Chennai', 'Tamil Nadu', 'Teacher · education & child rights', 'meera', { preferredAreas: ['Education'] }],
    ['rohan_gupta', 'Rohan Gupta', 'Mumbai', 'Maharashtra', 'Weekend animal rescuer · Sunday feeding runs', 'rohan', { preferredAreas: ['Animal Welfare'] }],
    ['kabir_khan', 'Kabir Khan', 'Pune', 'Maharashtra', 'Football coach for under-14s', 'kabir', { preferredAreas: ['Community Development'] }],
    ['diya_patel', 'Diya Patel', 'Ahmedabad', 'Gujarat', 'Street theatre for social change', 'diya', { preferredAreas: ['Healthcare', 'Community Development'] }],
    ['vikram_rao', 'Vikram Rao', 'Bengaluru', 'Karnataka', 'Engineering student · STEM for government schools', 'vikram', { preferredAreas: ['Education', 'Environmental Conservation'] }],
    ['zoya_ali', 'Zoya Ali', 'Mumbai', 'Maharashtra', "Women's health awareness", 'zoya', { preferredAreas: ['Healthcare'] }],
    ['ishaan_verma', 'Ishaan Verma', 'Jaipur', 'Rajasthan', 'Community kitchens · no one sleeps hungry', 'ishaan', { preferredAreas: ['Community Development', 'Disaster Relief'] }],
    ['asha_nair', 'Asha Nair', 'Delhi', 'Delhi', 'River clean-ups on the Yamuna', 'asha', { preferredAreas: ['Environmental Conservation'] }],
    ['ravi_kumar', 'Ravi Kumar', 'Lucknow', 'Uttar Pradesh', 'Retired teacher · evening classes', 'ravi', { preferredAreas: ['Education'] }],
];
const TEAM = ['myvol_team', 'MyVol Team'];
// Aarav follows these; the other four show up in his suggestions and suggested posts.
const AARAV_FOLLOWS = ['priya_sharma', 'ananya_singh', 'meera_iyer', 'rohan_gupta', 'kabir_khan', 'diya_patel', 'vikram_rao'];
// These two ask to follow Aarav after he switches to "approve followers": pending requests.
const REQUESTERS = ['asha_nair', 'ravi_kumar'];
const PRIVATE = ['meera_iyer'];

const args = process.argv.slice(2);
const SEEDED = { email: { endsWith: DOMAIN } };

const reset = async () => {
    const users = await prisma.user.findMany({ where: SEEDED, select: { id: true } });
    if (!users.length) return;
    await prisma.announcement.deleteMany({ where: { createdById: { in: users.map((u) => u.id) } } });
    await prisma.user.updateMany({ where: { id: { in: users.map((u) => u.id) } }, data: { status: 'PENDING_DELETION', deletionScheduledAt: new Date() } });
    await runAuthCleanup();
    console.log(`Removed ${users.length} showcase accounts and their files.`);
};

const idsByUsername = async () => {
    const rows = await prisma.user.findMany({ where: SEEDED, select: { id: true, username: true } });
    return Object.fromEntries(rows.map((r) => [r.username, r.id]));
};

// ---------- stories (also used by --stories) ----------
const postStories = async (u) => {
    const old = await prisma.story.findMany({ where: { authorId: { in: Object.values(u) } } });
    for (const story of old) await stories.removeStory(story); // files too
    // [author, caption, media, hours ago]
    const list = [
        ['priya_sharma', 'Packing meal kits since 7am', photo('cat_hunger'), 9],
        ['priya_sharma', '', video('story_food'), 2],
        ['ananya_singh', '200 check-ups and counting', photo('health_camp'), 5],
        ['rohan_gupta', 'Our Sunday regulars', photo('animal_feeding'), 7],
        ['meera_iyer', 'Reading hour with class 4', photo('tutoring'), 3],
        ['kabir_khan', 'Match day for the under-14s', photo('youth_sports'), 6],
        ['vikram_rao', 'Science fair models are ready', photo('science_fair_2'), 4],
        [ME, 'Saplings ready for Sunday', photo('sapling_drive'), 8],
    ];
    const made = {};
    for (const [who, caption, file, hoursAgo] of list) {
        const story = await stories.createStory(u[who], { caption }, file);
        const createdAt = new Date(Date.now() - hoursAgo * HOUR_MS);
        await prisma.story.update({ where: { id: story.id }, data: { createdAt, expiresAt: new Date(createdAt.getTime() + DAY_MS) } });
        (made[who] ??= []).push(story.id);
    }
    // Aarav's own story: viewers and likes (Activity rows + the viewers sheet).
    const mine = made[ME][0];
    for (const viewer of ['priya_sharma', 'ananya_singh', 'rohan_gupta', 'kabir_khan', 'meera_iyer', 'diya_patel', 'vikram_rao', 'zoya_ali']) {
        await stories.markSeen(u[viewer], mine);
    }
    for (const liker of ['priya_sharma', 'rohan_gupta', 'kabir_khan']) await stories.likeStory(u[liker], mine);
    // Aarav has watched Priya's first story and Kabir's: their rings show partly/fully seen.
    await stories.markSeen(u[ME], made.priya_sharma[0]);
    await stories.markSeen(u[ME], made.kabir_khan[0]);
    await notifications.settle();
};

const main = async () => {
    if (env.isProd) throw new Error('Refusing to seed showcase data in production');

    if (args.includes('--stories')) {
        const u = await idsByUsername();
        if (!u[ME]) throw new Error('No showcase data yet. Run npm run demo:seed first.');
        await postStories(u);
        console.log('Stories re-posted (they last 24 hours).');
        return;
    }

    if (args.includes('--reset')) await reset();
    if (await prisma.user.count({ where: SEEDED })) {
        console.log('Showcase data already exists. Run with -- --reset to recreate it.');
        return;
    }

    const passwordHash = await hashPassword(PASSWORD);
    const u = {};
    const step = (text) => console.log(`- ${text}`);
    const joined = (days) => new Date(Date.now() - days * DAY_MS);

    // ---------- accounts ----------
    step('accounts');
    for (const [i, [username, name, city, state, bio, portrait, profile]] of USERS.entries()) {
        const user = await prisma.user.create({
            data: {
                email: `${username}${DOMAIN}`,
                username,
                name,
                bio,
                passwordHash,
                dateOfBirth: new Date(1994 + (i % 8), i % 12, 10 + i),
                emailVerifiedAt: new Date(),
                termsAcceptedAt: new Date(),
                createdAt: joined(120 - i * 4),
                profile: { create: { city, state, country: 'India', ...profile } },
            },
        });
        u[username] = user.id;
        await profiles.setAvatar(user.id, avatar(portrait));
    }
    const team = await prisma.user.create({
        data: {
            email: `${TEAM[0]}${DOMAIN}`,
            username: TEAM[0],
            name: TEAM[1],
            bio: 'News from the MyVol team',
            passwordHash,
            role: 'ADMIN',
            dateOfBirth: new Date('1990-01-01'),
            emailVerifiedAt: new Date(),
            termsAcceptedAt: new Date(),
            createdAt: joined(150),
            profile: { create: { city: 'Delhi', country: 'India' } },
        },
    });
    await accountSettings.updateSettings(team.id, { suggestToOthers: false });

    // ---------- follow graph ----------
    // Everyone follows everyone (so anyone can be named as "who was with you"), except
    // that Aarav follows only AARAV_FOLLOWS, and REQUESTERS ask to follow him later.
    step('follows');
    const volunteers = USERS.map(([username]) => username);
    for (const a of volunteers) {
        for (const b of volunteers) {
            if (a === b) continue;
            if (a === ME && !AARAV_FOLLOWS.includes(b)) continue;
            if (b === ME && REQUESTERS.includes(a)) continue;
            if (PRIVATE.includes(b)) continue; // after Meera goes private, below
            await follows.follow(u[a], b);
        }
    }
    // Meera is private: everyone asks, she accepts (Aarav gets "Meera accepted your request").
    await prisma.user.update({ where: { id: u.meera_iyer }, data: { isPrivate: true } });
    for (const a of volunteers) {
        if (a === 'meera_iyer') continue;
        await follows.follow(u[a], 'meera_iyer');
        await follows.acceptRequest(u.meera_iyer, u[a]);
    }

    // ---------- posts ----------
    // Created oldest first (an inspired post must be newer than its source), then dated.
    const dated = []; // [post id, days ago]
    const create = async (who, daysAgo, data, files = [], aspect) => {
        const post = await posts.createPost(u[who], { beneficiaries: 0, hours: 0, ...data, ...(aspect && { aspect }) }, files);
        dated.push([post.id, daysAgo]);
        return post;
    };
    const p = {};
    const MUM = 'Mumbai, Maharashtra';

    step('posts: the ripple root and Ananya’s older reel');
    p.a0 = await create(ME, 45, { title: 'Tree Plantation Drive', description: 'Planted 50 saplings with the residents association in Andheri. Each family adopted one! #treeplantation #greenmumbai', category: 'Environment', beneficiaries: 50, hours: 3, location: MUM }, [photo('tree_planting'), photo('sapling_drive')], '4:5');
    process.stdout.write('  reels: ');
    p.ananyaBlood = await create('ananya_singh', 24, { title: 'Blood Donation & Health Camp', description: 'Free check-ups and a blood donation drive with the local samiti. 150 residents came by! #healthforall', category: 'Health', beneficiaries: 150, hours: 5, location: 'Kolkata, West Bengal' }, [video('health_camp')]);
    console.log('1');

    // ---------- Aarav's activities: 13 approved = Gold medal, 13/25 to Platinum ----------
    step('posts: Aarav');
    p.a1 = await create(ME, 38, { title: 'Beach Cleanup at Juhu', description: '40 bags of plastic off the beach in two hours. Thank you to the 30 people who showed up! #cleanindia #greenmumbai', category: 'Environment', beneficiaries: 200, hours: 4, location: MUM }, [photo('river_cleanup_1'), photo('river_cleanup_2')], '4:5');
    p.a2 = await create(ME, 33, { title: 'Evening class for kids', description: 'Maths and English for 25 children from the basti near our station. #education', category: 'Education', beneficiaries: 25, hours: 2, location: MUM }, [photo('tutoring')], '1:1');
    p.a3 = await create(ME, 29, { title: 'Mangrove awareness walk', description: 'Walked 30 college students through the Mahim mangroves and why they protect our city. #greenmumbai', category: 'Environment', beneficiaries: 30, hours: 2, location: MUM }, [photo('cat_global_goals')], '4:5');
    p.a4 = await create(ME, 25, { title: 'Library book drive', description: 'Collected 300 books for the community library. Shelves are full again!', category: 'Education', beneficiaries: 120, hours: 3, location: MUM }, [photo('cat_education')], '4:5');
    p.a5 = await create(ME, 21, { title: 'Blood donation camp', description: 'After Ananya’s camp in Kolkata we ran one in our society: 80 donors registered. #healthforall', category: 'Health', beneficiaries: 80, hours: 5, location: MUM, inspiredByPostId: p.ananyaBlood.id, companions: ['vikram_rao'] }, [photo('blood_donation')], '4:5');
    await ripple.vouch(u.vikram_rao, p.a5.id, 'confirm'); // "Vikram vouched for your activity"
    p.a6 = await create(ME, 17, { title: 'Stray dog vaccination', description: 'Assisted the vet team with 45 dogs in our ward. Rohan, you are a legend.', category: 'Animal Welfare', beneficiaries: 45, hours: 4, location: MUM }, [photo('animal_feeding')], '4:5');
    p.a7 = await create(ME, 14, { title: 'Rainwater harvesting setup', description: 'Built a rooftop rainwater system for our building with the society committee. It will save around 1 lakh litres a year. #savewater', category: 'Environment', beneficiaries: 60, hours: 6, location: MUM });
    p.a8 = await create(ME, 10, { title: 'Food packet distribution', description: 'Meals for 150 families near Dadar station with Priya’s team. #nohunger', category: 'Hunger & Poverty', beneficiaries: 150, hours: 3, location: MUM }, [photo('food_distribution')], '4:5');
    p.a9 = await create(ME, 7, { title: 'Career talk at a government school', description: 'Spoke to class 10 about careers in science and the environment. So many good questions!', category: 'Youth & Sports', beneficiaries: 90, hours: 1, location: MUM }, [photo('science_fair_1')], '1:1');
    process.stdout.write('  reels: ');
    p.a10 = await create(ME, 4, { title: 'Mithi river cleanup', description: 'Before and after: swipe to see the riverbank today. #cleanindia', category: 'Environment', beneficiaries: 0, hours: 3, location: MUM }, [photo('river_cleanup_2'), video('river_cleanup')]);
    process.stdout.write('2 ');
    p.a11 = await create(ME, 2, { title: 'Monsoon planting', description: 'Second round of saplings before the rains end. Join us next Sunday! #treeplantation', category: 'Environment', beneficiaries: 40, hours: 3, location: MUM }, [video('tree_planting')]);
    console.log('3');
    p.a12 = await create(ME, 1, { title: 'Menstrual hygiene workshop', description: 'Sessions for 60 girls with a partner NGO, plus a year of supplies for the school.', category: 'Gender Equality', beneficiaries: 60, hours: 2, location: MUM }, [photo('gender_workshop')], '4:5');

    // ---------- the ripple from Aarav's tree drive ----------
    // a0 (Mumbai) ── Priya (Thane) ── Vikram (Bengaluru) ── Rohan (Mumbai) ── Ravi (Lucknow) ── Asha (Delhi)
    //            │                 └─ Meera (Chennai)
    //            ├─ Ananya (Kolkata) ── Diya (Ahmedabad) ── Zoya (Mumbai)
    //            └─ Kabir (Pune) ── Ishaan (Jaipur)
    // 11 people, 5 levels, 9 cities: Spark, Wave, City Hopper, and the hidden Full Circle
    // (Rohan and Zoya posted in Mumbai) and Spotlight (one post, 10+ people). Six Degrees
    // stays a secret; Tide (20 people) is the next badge. Every link is vouched for by a
    // companion who isn't up the chain.
    step('ripple: inspired posts and vouches');
    const inspired = async (who, source, companion, daysAgo, data, files) => {
        const post = await create(who, daysAgo, { ...data, inspiredByPostId: source.id, companions: [companion] }, files, files.length ? '4:5' : undefined);
        await ripple.vouch(u[companion], post.id, 'confirm');
        return post;
    };
    await ripple.pledge(u.priya_sharma, p.a0.id); // fulfilled by her post below
    p.priyaTrees = await inspired('priya_sharma', p.a0, 'meera_iyer', 40, { title: 'Tree planting in our society', description: 'Saw Aarav’s drive and did the same: 20 saplings along our lane! #treeplantation', category: 'Environment', beneficiaries: 20, hours: 2, location: 'Thane, Maharashtra' }, [photo('sapling_drive')]);
    p.ananyaTrees = await inspired('ananya_singh', p.a0, 'priya_sharma', 36, { title: 'A green corner at the health centre', description: 'Inspired by Aarav: 15 saplings so patients have some shade while they wait.', category: 'Environment', beneficiaries: 40, hours: 2, location: 'Kolkata, West Bengal' }, [photo('tree_planting')]);
    p.kabirTrees = await inspired('kabir_khan', p.a0, 'ishaan_verma', 34, { title: 'Saplings around the football ground', description: 'Our under-14 team planted 25 trees after seeing Aarav’s post. #treeplantation', category: 'Environment', beneficiaries: 25, hours: 2, location: 'Pune, Maharashtra' }, [photo('youth_sports')]);
    p.vikramTrees = await inspired('vikram_rao', p.priyaTrees, 'kabir_khan', 30, { title: 'Campus tree drive', description: 'Priya’s post got our whole college going: 60 trees in one morning.', category: 'Environment', beneficiaries: 60, hours: 3, location: 'Bengaluru, Karnataka' }, [photo('cat_global_goals')]);
    p.meeraTrees = await inspired('meera_iyer', p.priyaTrees, 'zoya_ali', 27, { title: 'A tree for every student', description: 'Class 4 planted and named their own trees in the school yard.', category: 'Environment', beneficiaries: 35, hours: 2, location: 'Chennai, Tamil Nadu' }, [photo('cat_child_rights')]);
    p.diyaTrees = await inspired('diya_patel', p.ananyaTrees, 'zoya_ali', 26, { title: 'Street play: plant, don’t pave', description: 'Our nukkad natak on green spaces, followed by planting 30 saplings with the audience.', category: 'Environment', beneficiaries: 120, hours: 3, location: 'Ahmedabad, Gujarat' }, [photo('cat_drug_prevention')]);
    p.ishaanTrees = await inspired('ishaan_verma', p.kabirTrees, 'diya_patel', 22, { title: 'Neem trees at the community kitchen', description: 'Shade for the queue at our kitchen, thanks to Kabir’s team for the idea.', category: 'Environment', beneficiaries: 30, hours: 2, location: 'Jaipur, Rajasthan' }, [photo('cat_hunger')]);
    p.rohanTrees = await inspired('rohan_gupta', p.vikramTrees, 'ananya_singh', 20, { title: 'Trees for the animal shelter', description: 'Shade for the dogs, after Vikram’s campus drive. #treeplantation', category: 'Environment', beneficiaries: 30, hours: 2, location: MUM }, [photo('cat_animal_welfare')]);
    p.zoyaTrees = await inspired('zoya_ali', p.diyaTrees, 'rohan_gupta', 16, { title: 'Saplings at the women’s health centre', description: 'Diya’s street play stayed with me. 12 saplings at our centre in Bandra.', category: 'Environment', beneficiaries: 50, hours: 2, location: MUM }, [photo('cat_womens_health')]);
    p.raviTrees = await inspired('ravi_kumar', p.rohanTrees, 'ishaan_verma', 12, { title: 'School garden with my old students', description: 'Rohan’s shelter post reminded me of our school garden. We brought it back.', category: 'Environment', beneficiaries: 45, hours: 4, location: 'Lucknow, Uttar Pradesh' }, [photo('science_fair_2')]);
    p.ashaTrees = await inspired('asha_nair', p.raviTrees, 'kabir_khan', 6, { title: 'Trees on the Yamuna bank', description: 'After Ravi sir’s garden: 40 saplings where we clean every month. #treeplantation #cleanindia', category: 'Environment', beneficiaries: 40, hours: 3, location: 'Delhi, Delhi' }, [photo('river_cleanup_1')]);

    // ---------- everyone else's activities ----------
    step('posts: the community');
    process.stdout.write('  reels: ');
    p.meeraReel = await create('meera_iyer', 6, { title: 'School Science Fair Mentoring', description: 'Kids built their models from scratch. So proud of them! #education', category: 'Education', beneficiaries: 35, hours: 5, location: 'Chennai, Tamil Nadu' }, [video('kids_mentoring')]);
    process.stdout.write('1 ');
    p.rohanReel = await create('rohan_gupta', 1.5, { title: 'Street Animal Feeding Drive', description: 'Feeding and first aid for 40 street dogs in our area. Every Sunday, 7 am.', category: 'Animal Welfare', beneficiaries: 40, hours: 2, location: MUM }, [video('animal_feeding')]);
    process.stdout.write('2 ');
    p.priyaReel = await create('priya_sharma', 1, { title: 'Community Food Distribution', description: 'Meals for 120 families this weekend. Thank you, team! #nohunger', category: 'Hunger & Poverty', beneficiaries: 120, hours: 4, location: 'Thane, Maharashtra' }, [video('food_distribution')]);
    console.log('3');
    p.rohanAdopt = await create('rohan_gupta', 8, { title: 'Pet adoption fair', description: 'Found homes for 12 puppies in one afternoon!', category: 'Animal Welfare', beneficiaries: 12, hours: 5, location: MUM }, [photo('cat_animal_welfare')], '4:5');
    p.ravi1 = await create('ravi_kumar', 9, { title: 'Evening classes, year two', description: 'Our free evening classes now have 40 regular students. #education', category: 'Education', beneficiaries: 40, hours: 10, location: 'Lucknow, Uttar Pradesh' }, [photo('tutoring')], '4:5');
    p.vikram1 = await create('vikram_rao', 5, { title: 'Science fair at a government school', description: 'Taught 50 kids to build working models with scrap material. #education', category: 'Education', beneficiaries: 50, hours: 6, location: 'Bengaluru, Karnataka' }, [photo('science_fair_2'), photo('science_fair_1')], '4:5');
    p.diya1 = await create('diya_patel', 4, { title: 'Nukkad natak against drugs', description: 'Performed in 3 colleges this week. The conversations after each show were the best part.', category: 'Drug Prevention', beneficiaries: 400, hours: 6, location: 'Ahmedabad, Gujarat' }, [photo('cat_drug_prevention')], '4:5');
    p.priyaChild = await create('priya_sharma', 3, { title: 'Child Rights Awareness Camp', description: 'Sessions with 60 parents on school enrolment and child safety.', category: 'Child Rights', beneficiaries: 60, hours: 3, location: 'Thane, Maharashtra' }, [photo('child_rights'), photo('cat_child_rights')], '4:5');
    p.meera1 = await create('meera_iyer', 3, { title: 'Evening tutoring classes', description: 'Maths and English for 25 children, every weekday at 6 pm.', category: 'Education', beneficiaries: 25, hours: 10, location: 'Chennai, Tamil Nadu' }, [photo('cat_education')], '4:5');
    p.asha1 = await create('asha_nair', 3, { title: 'Yamuna clean-up, month 12', description: 'One year of monthly clean-ups. 2 tonnes of waste so far. #cleanindia', category: 'Environment', beneficiaries: 0, hours: 4, location: 'Delhi, Delhi' }, [photo('river_cleanup_2')], '4:5');
    p.kabir1 = await create('kabir_khan', 2.5, { title: 'Under-14 football camp', description: 'Free coaching for 30 kids from the nearby slum. Two of them made the district team! #youthsports', category: 'Youth & Sports', beneficiaries: 30, hours: 8, location: 'Pune, Maharashtra' }, [photo('youth_sports')], '1:1');
    p.ananyaCamp = await create('ananya_singh', 2, { title: 'Free Health Camp', description: 'Blood pressure and sugar checks for 200 residents. #healthforall', category: 'Health', beneficiaries: 200, hours: 6, location: 'Kolkata, West Bengal' }, [photo('health_camp'), photo('cat_health')], '4:5');
    p.ishaan1 = await create('ishaan_verma', 2, { title: 'Community kitchen, day 100', description: '100 days, 30,000 meals. Thank you to every volunteer who chopped, cooked and served. #nohunger', category: 'Hunger & Poverty', beneficiaries: 300, hours: 8, location: 'Jaipur, Rajasthan' }, [photo('food_distribution')], '4:5');
    p.zoya1 = await create('zoya_ali', 1, { title: "Women's health awareness session", description: 'Talked about anaemia and nutrition with 45 women in Dharavi. #healthforall', category: 'Health', beneficiaries: 45, hours: 2, location: MUM }, [photo('cat_womens_health')], '4:5');
    p.priyaAsk = await create('priya_sharma', 0.3, { title: 'Volunteers needed this Sunday', description: 'Need 10 more hands for the food drive at Thane station, 8 am. Comment if you can make it! #nohunger', category: 'Hunger & Poverty', beneficiaries: 0, hours: 0, location: 'Thane, Maharashtra' });
    // Waiting for Aarav: Meera named him as "who was with you" (a vouch request).
    p.meeraReading = await create('meera_iyer', 0.5, { title: 'Reading circle for parents', description: 'After Priya’s camp: a Saturday reading circle so parents can help with homework. Aarav came along to help!', category: 'Child Rights', beneficiaries: 20, hours: 2, location: 'Chennai, Tamil Nadu', inspiredByPostId: p.priyaChild.id, companions: [ME] }, [photo('tutoring')], '4:5');

    // ---------- pledges ----------
    step('pledges');
    await ripple.pledge(u.rohan_gupta, p.a11.id);
    await ripple.pledge(u.zoya_ali, p.a10.id);
    await ripple.pledge(u.kabir_khan, p.a11.id);
    await ripple.pledge(u[ME], p.ananyaCamp.id); // Aarav's own open pledge (his ripple "to do")

    // ---------- reactions, saves, shares, views ----------
    step('reactions, saves, shares, views');
    const REACTIONS = ['good', 'excellent', 'fabulous', 'good', 'excellent', 'good'];
    const authorOf = Object.fromEntries((await prisma.post.findMany({ where: { id: { in: Object.values(p).map((x) => x.id) } }, select: { id: true, authorId: true } })).map((r) => [r.id, r.authorId]));
    const reactors = USERS.map(([username]) => username);
    for (const [k, post] of Object.values(p).entries()) {
        for (const [j, who] of reactors.entries()) {
            if (u[who] === authorOf[post.id]) continue;
            if (who === ME && !AARAV_FOLLOWS.includes(Object.keys(u).find((n) => u[n] === authorOf[post.id]))) continue;
            // Aarav's own posts get the most; everyone else's a fair share.
            const mine = authorOf[post.id] === u[ME];
            if (!mine && (k + j) % 3 === 0) continue;
            await posts.likePost(u[who], post.id, REACTIONS[(k + j) % REACTIONS.length]);
        }
    }
    for (const id of [p.priyaReel.id, p.ananyaCamp.id, p.meera1.id, p.kabir1.id]) await posts.savePost(u[ME], id);
    for (const who of ['priya_sharma', 'ananya_singh', 'rohan_gupta', 'kabir_khan']) await posts.savePost(u[who], p.a0.id);
    for (const who of ['priya_sharma', 'rohan_gupta', 'vikram_rao', 'zoya_ali']) await posts.sharePost(u[who], p.a0.id);
    for (const who of ['meera_iyer', 'diya_patel']) await posts.sharePost(u[who], p.a1.id);
    for (const reel of [p.a10, p.a11, p.ananyaBlood, p.meeraReel, p.rohanReel, p.priyaReel]) {
        for (const [j, who] of reactors.entries()) {
            if (u[who] === authorOf[reel.id]) continue;
            await posts.recordView(u[who], reel.id, { watchMs: 4000 + j * 700 });
        }
    }

    // ---------- comments ----------
    step('comments and replies');
    const say = (who, post, text, parent) => comments.addComment(u[who], post.id, { text, ...(parent && { parentId: parent.id }) });
    const c1 = await say('priya_sharma', p.a0, 'This is beautiful, Aarav! We are doing the same in Thane next week.');
    await say(ME, p.a0, 'Do it! Happy to send you the list of nurseries we used.', c1);
    await say('priya_sharma', p.a0, 'Yes please!', c1);
    await say('vikram_rao', p.a0, 'Which saplings did you choose? Native species?');
    await say('ananya_singh', p.a0, 'Shared this with our residents group in Kolkata.');
    const c2 = await say('rohan_gupta', p.a11, 'Count me in for Sunday!');
    await say(ME, p.a11, 'See you at 8, bring gloves.', c2);
    await say('kabir_khan', p.a11, 'Bringing the under-14 team along.');
    await say('meera_iyer', p.a10, 'The after photo is unreal. Great work.');
    await say('zoya_ali', p.a10, 'Joining the next one!');
    await say('diya_patel', p.a1, '40 bags! Respect.');
    await say('priya_sharma', p.a8, 'Thank you for coming with us. The families loved it.');
    await say('ananya_singh', p.a5, 'So glad the camp idea travelled to Mumbai!');
    await say('vikram_rao', p.a12, 'Really important work.');
    await say('rohan_gupta', p.a6, 'Couldn’t have done it without you!');
    const c3 = await say(ME, p.priyaReel, 'Amazing work, team!');
    await say('priya_sharma', p.priyaReel, 'Thank you Aarav! See you on Sunday.', c3);
    await say('ishaan_verma', p.priyaReel, 'Would love to collaborate with our Jaipur kitchen.');
    const c4 = await say(ME, p.ananyaCamp, 'I pledged to run one of these in Mumbai next month.');
    await say('ananya_singh', p.ananyaCamp, 'Let me know if you need the checklist we use!', c4);
    await say('priya_sharma', p.ananyaCamp, 'So needed in our area!');
    await say(ME, p.priyaAsk, 'I’m in, and bringing two friends.');
    await say('rohan_gupta', p.priyaAsk, 'Me too!');
    await say(ME, p.kabir1, 'Two in the district team! Huge.');
    await say('kabir_khan', p.kabir1, 'Thanks Aarav!');
    await say('meera_iyer', p.vikram1, 'Love the scrap-material models.');
    await say(ME, p.rohanReel, 'Sunday regulars!');
    // Comment likes: on Aarav's comments (his Activity) and on others'.
    for (const who of ['priya_sharma', 'ananya_singh', 'kabir_khan']) await comments.likeComment(u[who], c3.id);
    await comments.likeComment(u.ananya_singh, c4.id);
    await comments.likeComment(u[ME], c1.id);
    await comments.likeComment(u[ME], c2.id);

    // ---------- staff picks + an announcement ----------
    step('featured posts and an announcement');
    for (const post of [p.ananyaCamp, p.priyaChild, p.a10, p.ishaan1]) await moderation.setFeatured(team.id, post.id, true);

    // ---------- Aarav approves followers from now on: two pending requests ----------
    step('follow requests');
    await accountSettings.updateSettings(u[ME], { whoCanFollow: 'approve' });
    for (const who of REQUESTERS) await follows.follow(u[who], ME);

    // ---------- dates: posts, comments, people ----------
    step('dates');
    for (const [id, daysAgo] of dated) {
        await prisma.post.update({ where: { id }, data: { createdAt: new Date(Date.now() - daysAgo * DAY_MS) } });
    }
    // Comments: an hour or two after their post (or the one before them), never in the future.
    await prisma.$executeRaw`
        UPDATE comments c SET created_at = LEAST(p.created_at + (r.rn * interval '83 minutes'), now() - ((40 - LEAST(r.rn, 39)) * interval '2 minutes'))
        FROM posts p, (SELECT id, row_number() OVER (PARTITION BY post_id ORDER BY created_at) AS rn FROM comments) r
        WHERE c.post_id = p.id AND r.id = c.id AND p.author_id = ANY(${Object.values(u)}::uuid[])`;
    // Ripple links were verified around when they were posted.
    await prisma.$executeRaw`
        UPDATE posts SET ripple_verified_at = created_at + interval '5 hours'
        WHERE ripple_status = 'VERIFIED' AND author_id = ANY(${Object.values(u)}::uuid[])`;

    await notifications.settle();
    await announcements.create(team.id, {
        title: 'Volunteer Week starts Monday',
        body: 'Log one activity every day next week and see how far your ripple goes. Share your best moments with #VolunteerWeek.',
        audience: {},
    });

    // ---------- stories (last, so they are fresh) ----------
    step('stories');
    await postStories(u);

    // ---------- Aarav's Activity: spread over the last few days, the newest unread ----------
    step('activity timeline');
    const rows = await prisma.notification.findMany({ where: { recipientId: u[ME] }, orderBy: { createdAt: 'asc' }, select: { id: true, type: true } });
    const UNREAD = 9;
    const span = 5 * DAY_MS;
    for (const [i, row] of rows.entries()) {
        const fromEnd = rows.length - 1 - i;
        const at = fromEnd < UNREAD ? new Date(Date.now() - (fromEnd * 17 + 4) * 60_000) : new Date(Date.now() - 3 * HOUR_MS - (fromEnd / rows.length) * span);
        // Badges are read except the newest (Spotlight): signing in shows its celebration.
        await prisma.notification.update({ where: { id: row.id }, data: { createdAt: at, readAt: fromEnd < UNREAD ? null : at } });
    }
    const latestBadge = await prisma.notification.findFirst({ where: { recipientId: u[ME], type: 'BADGE_EARNED' }, orderBy: { createdAt: 'desc' } });
    await prisma.notification.updateMany({ where: { recipientId: u[ME], type: 'BADGE_EARNED', NOT: { id: latestBadge?.id } }, data: { readAt: new Date() } });
    // Newest of all: the app celebrates unread badges from the first page of Activity only.
    if (latestBadge) await prisma.notification.update({ where: { id: latestBadge.id }, data: { readAt: null, createdAt: new Date(Date.now() - 60_000) } });

    // ---------- summary ----------
    const me = await prisma.user.findUnique({ where: { id: u[ME] }, select: { followersCount: true, followingCount: true } });
    const stats = await ripple.statsFor(u[ME]);
    const badges = await prisma.userBadge.findMany({ where: { userId: u[ME] }, select: { badgeId: true } });
    const byType = await prisma.notification.groupBy({ by: ['type'], where: { recipientId: u[ME] }, _count: true });
    console.log('\nShowcase ready. Log in as %s / %s', ME, PASSWORD);
    console.log('Aarav: %d followers, %d following, %d activities', me.followersCount, me.followingCount, await prisma.post.count({ where: { authorId: u[ME] } }));
    console.log('Ripple:', stats, '\nBadges:', badges.map((b) => b.badgeId).join(', '));
    console.log('Activity:', byType.map((t) => `${t.type} ${t._count}`).join(', '));
    console.log('Stories expire in 24 h: refresh them before the demo with  npm run demo:seed -- --stories');
};

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
