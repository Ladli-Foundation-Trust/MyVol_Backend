const AppError = require('./appError');

// Keyset pagination (newest first, or oldest first for comment threads). The cursor is an opaque string the
// client sends back as ?cursor=; it encodes the last row's (createdAt, id). Unlike
// OFFSET, pages don't skip or repeat rows when people follow/unfollow meanwhile.

const UUID = /^[0-9a-f-]{36}$/i;

const encodeCursor = (createdAt, id) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

const decodeCursor = (cursor) => {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !UUID.test(id ?? '')) {
        throw new AppError('Invalid cursor', 400, undefined, 'INVALID_CURSOR');
    }
    return { createdAt, id };
};

// Prisma `where` for rows after the cursor, ordered by createdAt then idField, both
// 'desc' (default) or both 'asc'. Put it inside an AND if the query has its own OR.
const afterCursor = (cursor, idField, direction = 'desc') => {
    if (!cursor) return {};
    const { createdAt, id } = decodeCursor(cursor);
    const op = direction === 'asc' ? 'gt' : 'lt';
    return { OR: [{ createdAt: { [op]: createdAt } }, { createdAt, [idField]: { [op]: id } }] };
};

// Query with take: limit + 1, then pass the rows here: the extra row only tells
// us whether there is a next page.
const toPage = (rows, limit, idField) => {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit ? encodeCursor(last.createdAt, last[idField]) : null };
};

// ---------- offset cursors (ranked lists: search, trending) ----------

// Ranked lists can't use keyset paging (the order isn't by createdAt), so they page by
// offset behind the same kind of opaque cursor: "o:40" in base64url.
const MAX_OFFSET = 500; // nobody pages that far; keeps queries bounded

const encodeOffset = (n) => Buffer.from(`o:${n}`).toString('base64url');

const decodeOffset = (cursor) => {
    if (!cursor) return 0;
    const match = /^o:(\d{1,4})$/.exec(Buffer.from(cursor, 'base64url').toString());
    const n = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(n) || n > MAX_OFFSET) throw new AppError('Invalid cursor', 400, undefined, 'INVALID_CURSOR');
    return n;
};

// `rows` fetched with take: limit + 1 starting at `offset`.
const offsetPage = (rows, offset, limit) => ({
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit && offset + limit <= MAX_OFFSET ? encodeOffset(offset + limit) : null,
});

module.exports = { afterCursor, toPage, MAX_OFFSET, decodeOffset, offsetPage };
