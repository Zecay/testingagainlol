// /api/auth.js - Vercel Serverless Function with Supabase
// Secure account system using bcryptjs + Supabase Postgres
// Table SQL (run in Supabase SQL editor):
/*
create extension if not exists pgcrypto;

create table users (
  id uuid default gen_random_uuid() primary key,
  username text not null unique,
  username_lower text not null unique,
  password_hash text not null,
  avatar text,
  created_at bigint not null,
  last_login bigint not null,
  login_count integer default 1
);
-- Indexes for fast lookup
create index if not exists users_lower_idx on users (username_lower);
*/

import { hashPassword, verifyPassword, isValidPasswordFormat } from './_lib/hash.js';
import { findUserByUsernameLower, createUserInDb, updateUserOnLogin, sanitizeUserFromDb } from './_lib/supabase.js';

const BAD_WORDS = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) {
    return typeof s === 'string' && BAD_WORDS.test(s.toLowerCase());
}

function isValidUsername(name) {
    if (!name || !name.trim()) return { ok: false, reason: 'Username cannot be empty.' };
    const n = name.trim();
    if (n.length > 25) return { ok: false, reason: 'Username must be 25 chars or less.' };
    if (n.length < 3) return { ok: false, reason: 'Username must be at least 3 characters.' };
    if (!/^[a-zA-Z0-9_ \-]+$/.test(n)) return { ok: false, reason: 'Only letters, numbers, spaces, dashes, underscores allowed.' };
    if (isBad(n)) return { ok: false, reason: 'That username is not allowed.' };
    return { ok: true };
}

function isValidAvatar(str) {
    if (!str) return true;
    if (typeof str !== 'string') return false;
    if (str.length > 200000) return false;
    if (str.length < 10) return false;
    return (
        str.startsWith('data:image/') ||
        str.startsWith('https://') ||
        str.startsWith('http://')
    );
}

async function getBody(req) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) return req.body;
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
            try {
                if (!data) return resolve({});
                resolve(JSON.parse(data));
            } catch {
                try {
                    const params = new URLSearchParams(data);
                    const obj = {};
                    for (const [k,v] of params.entries()) obj[k]=v;
                    resolve(obj);
                } catch { resolve({}); }
            }
        });
        req.on('error', () => resolve({}));
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        const body = req.method === 'POST' ? await getBody(req) : {};
        const q = req.query || {};
        const p = { ...q, ...body };

        let { username, name, password, action, avatar } = p;

        if (!username && name) username = name;
        if (username) { try { username = decodeURIComponent(username); } catch {} }
        if (password) { try { password = decodeURIComponent(password); } catch {} }
        if (avatar) { try { avatar = decodeURIComponent(avatar); } catch {} }

        if (!username) return res.status(200).json({ ok: false, error: 'Missing username' });
        if (!password) return res.status(200).json({ ok: false, error: 'Missing password' });

        const usernameCheck = isValidUsername(username);
        if (!usernameCheck.ok) return res.status(200).json({ ok: false, error: usernameCheck.reason });

        const passwordCheck = isValidPasswordFormat(password);
        if (!passwordCheck.ok) return res.status(200).json({ ok: false, error: passwordCheck.reason });

        if (avatar && !isValidAvatar(avatar)) avatar = null;

        const usernameTrimmed = username.trim();
        const lower = usernameTrimmed.toLowerCase();

        // Try to find existing user in Supabase
        const existing = await findUserByUsernameLower(lower);

        if (action === 'register') {
            if (existing) {
                return res.status(200).json({ ok: false, error: 'Username already taken. Try logging in.' });
            }
            const hash = await hashPassword(password);
            const created = await createUserInDb({
                username: usernameTrimmed,
                username_lower: lower,
                password_hash: hash,
                avatar: avatar || null
            });
            return res.status(200).json({
                ok: true,
                action: 'registered',
                message: 'Account created successfully',
                user: sanitizeUserFromDb(created)
            });
        }

        // Login flow
        if (existing) {
            const match = await verifyPassword(password, existing.password_hash);
            if (!match) {
                return res.status(200).json({ ok: false, error: 'Invalid password. Please try again.' });
            }
            const updated = await updateUserOnLogin(existing.id, { avatar: avatar || null });
            const userToReturn = updated || existing;
            // If avatar was provided and we updated, ensure returned has new avatar
            if (avatar) userToReturn.avatar = avatar;
            return res.status(200).json({
                ok: true,
                action: 'login',
                message: 'Login successful',
                user: sanitizeUserFromDb(userToReturn)
            });
        }

        // Auto-register on first login (smooth UX)
        const hash = await hashPassword(password);
        const created = await createUserInDb({
            username: usernameTrimmed,
            username_lower: lower,
            password_hash: hash,
            avatar: avatar || null
        });
        return res.status(200).json({
            ok: true,
            action: 'registered',
            message: 'Account created successfully',
            user: sanitizeUserFromDb(created)
        });

    } catch (err) {
        console.error('auth.js supabase error:', err);
        // Provide helpful message for missing env vars
        if (err.message && err.message.includes('SUPABASE')) {
            return res.status(500).json({ ok: false, error: 'Server not configured: ' + err.message + '. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel env vars.' });
        }
        return res.status(500).json({ ok: false, error: 'Internal server error: ' + err.message });
    }
}
