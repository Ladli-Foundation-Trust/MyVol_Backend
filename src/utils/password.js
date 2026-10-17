const argon2 = require('argon2');

const OPTIONS = { type: argon2.argon2id };

const hashPassword = (plain) => argon2.hash(plain, OPTIONS);

const verifyPassword = async (hash, plain) => {
    try {
        return await argon2.verify(hash, plain);
    } catch {
        return false;
    }
};


let dummyHashPromise;
const verifyDummy = async (plain) => {
    dummyHashPromise ??= hashPassword('dummy-password-for-timing');
    await verifyPassword(await dummyHashPromise, plain);
    return false;
};

module.exports = { hashPassword, verifyPassword, verifyDummy };
