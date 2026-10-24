// The medal ladder: approved activities needed for each tier, ascending. Same tiers
// as the app's homeContent.js MEDAL_TIERS (the API now sends them, so the app can drop
// its copy). Adding a tier here is the only change needed.
const MEDAL_TIERS = [
    { id: 'bronze', label: 'Bronze Medal', activities: 3 },
    { id: 'silver', label: 'Silver Medal', activities: 6 },
    { id: 'gold', label: 'Gold Medal', activities: 12 },
    { id: 'platinum', label: 'Platinum Medal', activities: 25 },
];

const tierById = (id) => MEDAL_TIERS.find((t) => t.id === id) ?? null;

module.exports = { MEDAL_TIERS, tierById };
