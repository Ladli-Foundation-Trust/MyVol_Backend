// Ripple: "Instagram shows what you posted. MyVolApp shows who you inspired."
//
// A post can name the post that inspired it (posts.inspired_by_post_id). Your ripple is
// everyone downstream of your posts: the people your activities inspired, the people
// THEY inspired, and so on (rippleService). Only counted posts make a ripple:
// APPROVED, by an ACTIVE account, with the link VERIFIED (a companion vouched for it,
// or a reviewer confirmed it).

// A badge is earned when every number it names is reached:
//   people    distinct volunteers in your ripple (ten posts by one person are one person)
//   depth     levels in the longest chain
//   cities    distinct cities among them
//   hometown  people at least 2 levels down who posted in your own profile city
//   bestPost  the most volunteers below any ONE of your posts
// Earned badges are kept for good (user_badges). Adding one here is the only change.
//
// Hidden badges are secrets: until earned, responses show only `hint` (no label,
// description or numbers), and they are never the "next" badge. Once earned they
// show like any other.
const RIPPLE_BADGES = [
    { id: 'spark', label: 'Spark', description: 'Inspired your first volunteer', people: 1 },
    { id: 'wave', label: 'Wave', description: 'Inspired 5 volunteers', people: 5 },
    { id: 'tide', label: 'Tide', description: 'Inspired 20 volunteers, 3 or more levels deep', people: 20, depth: 3 },
    { id: 'tsunami', label: 'Tsunami', description: 'Inspired 100 volunteers', people: 100 },
    { id: 'city_hopper', label: 'City Hopper', description: 'Your ripple reached 3 cities', cities: 3 },
    // Hidden.
    { id: 'six_degrees', label: 'Six Degrees', description: 'Your ripple travelled 6 people deep', depth: 6, hidden: true, hint: 'Let it travel far' },
    { id: 'full_circle', label: 'Full Circle', description: 'Your ripple came back to your own city', hometown: 1, hidden: true, hint: 'Somewhere close to home' },
    { id: 'spotlight', label: 'Spotlight', description: 'One activity of yours inspired 10 volunteers', bestPost: 10, hidden: true, hint: 'One post, many hands' },
];

const REQUIREMENTS = ['people', 'depth', 'cities', 'hometown', 'bestPost'];

// The numbers responses show. hometown and bestPost only decide hidden badges.
const PUBLIC_STATS = ['people', 'depth', 'cities'];
const publicStats = (stats) => Object.fromEntries(PUBLIC_STATS.map((k) => [k, stats[k]]));

const meets = (badge, stats) => REQUIREMENTS.every((k) => stats[k] >= (badge[k] ?? 0));

const badgeById = (id) => RIPPLE_BADGES.find((b) => b.id === id) ?? null;

// How long an "I'll do this too" pledge stays open.
const PLEDGE_DAYS = 60;

// Ripple trees stop here: a safety bound for the recursive queries. Real chains are short.
const MAX_DEPTH = 20;

// GET …/ripple/tree returns at most this many posts (`truncated: true` when cut).
const MAX_TREE_NODES = 300;

// "Who was with you": how many people an inspired post can name to vouch for it.
const MAX_COMPANIONS = 5;

module.exports = { RIPPLE_BADGES, REQUIREMENTS, publicStats, meets, badgeById, PLEDGE_DAYS, MAX_DEPTH, MAX_TREE_NODES, MAX_COMPANIONS };
