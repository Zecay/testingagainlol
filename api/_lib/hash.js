// api/_lib/hash.js - Password hashing utilities
// Uses bcryptjs (pure JS, no native build needed)
// Securely hashes passwords and verifies them

import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Hash a plain password using bcrypt
 * @param {string} plainPassword
 * @returns {Promise<string>} hashed password
 */
export async function hashPassword(plainPassword) {
    if (typeof plainPassword !== 'string' || plainPassword.length < 8) {
        throw new Error('Password must be at least 8 characters');
    }
    return await bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Verify a plain password against a hash
 * @param {string} plainPassword
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plainPassword, hash) {
    if (!plainPassword || !hash) return false;
    try {
        return await bcrypt.compare(plainPassword, hash);
    } catch (e) {
        console.error('bcrypt compare failed', e);
        return false;
    }
}

export function isValidPasswordFormat(pw) {
    if (typeof pw !== 'string') return { ok: false, reason: 'Password must be text' };
    if (pw.length < 8) return { ok: false, reason: 'Password must be at least 8 characters' };
    if (pw.length > 128) return { ok: false, reason: 'Password is too long (max 128)' };
    return { ok: true };
}
