// "Hide offensive comments" (the app's hideOffensiveComments setting): comments that
// match this list are flagged when written (comments.is_offensive) and hidden from
// everyone but their author while the post's author has the setting on. The post's
// author still finds them under "Hidden comments" (GET /posts/:id/comments?hidden=true).
//
// Deliberately short and conservative: common abuse and spam bait in English and
// romanised Hindi. Matching is per whole word, case-insensitive, after folding common
// look-alike characters (0->o, 1->i, 3->e, 4->a, 5->s, @->a, $->s). Extend the lists
// here; existing comments are not re-checked.

const WORDS = [
    // abuse (English)
    'idiot', 'stupid', 'moron', 'loser', 'dumb', 'shut up', 'fuck', 'fucking', 'fucker', 'shit', 'bullshit', 'bitch',
    'bastard', 'asshole', 'dick', 'crap', 'scumbag', 'retard', 'kill yourself', 'kys',
    // abuse (romanised Hindi)
    'chutiya', 'chutiye', 'bhosdike', 'madarchod', 'behenchod', 'bc', 'mc', 'gandu', 'harami', 'kamina', 'kutta', 'kutte', 'saala', 'saale',
    // spam bait
    'click here', 'free money', 'earn money fast', 'work from home and earn', 'dm for promotion', 'whatsapp me', 'buy followers',
    'crypto giveaway', 'guaranteed returns',
];

const LOOKALIKES = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's' };

const fold = (text) =>
    text
        .toLowerCase()
        .replace(/[013145@$]/g, (c) => LOOKALIKES[c] ?? c)
        .replace(/\s+/g, ' ');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole words/phrases only, so "class" or "scrap" don't match "ass" / "crap".
const PATTERN = new RegExp(`(^|[^\\p{L}\\p{N}])(${WORDS.map((w) => escape(fold(w))).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'u');

const isOffensive = (text) => PATTERN.test(fold(text ?? ''));

module.exports = { isOffensive, WORDS };
