// /api/auth.js - Vercel Serverless Function with Supabase + Admin support
// Secure account system using bcryptjs + Supabase Postgres
// Admins: Zecay, Cz2rek (hardcoded + is_admin column)
// Table SQL:
/*
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  username text not null unique,
  username_lower text not null unique,
  password_hash text not null,
  avatar text,
  created_at bigint not null,
  last_login bigint not null,
  login_count integer default 1,
  is_admin boolean default false
);

create table if not exists bans (
  id uuid default gen_random_uuid() primary key,
  username_lower text not null unique,
  username text not null,
  banned_by text,
  reason text,
  banned_at bigint not null,
  expires_at bigint
);

create table if not exists kicks (
  id uuid default gen_random_uuid() primary key,
  username_lower text not null,
  kicked_by text,
  kicked_at bigint not null
);

-- Give admin:
update users set is_admin = true where username_lower in ('zecay','cz2rek');
*/

import { hashPassword, verifyPassword, isValidPasswordFormat } from './_lib/hash.js';
import { findUserByUsernameLower, createUserInDb, updateUserOnLogin, sanitizeUserFromDb, isUserBanned } from './_lib/supabase.js';

const BAD_WORDS = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) { return typeof s === 'string' && BAD_WORDS.test(s.toLowerCase()); }

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
    return (str.startsWith('data:image/') || str.startsWith('https://') || str.startsWith('http://'));
}
async function getBody(req) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) return req.body;
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
            try { if (!data) return resolve({}); resolve(JSON.parse(data)); }
            catch { try { const params = new URLSearchParams(data); const obj={}; for (const [k,v] of params.entries()) obj[k]=v; resolve(obj);} catch { resolve({}); } }
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

        // Check ban first
        try {
            const banned = await isUserBanned(lower);
            if (banned) {
                return res.status(200).json({ ok: false, error: `You are banned. Reason: ${banned.reason || 'Banned by admin'}`, banned: true, banInfo: banned });
            }
        } catch (e) {
            console.warn('Ban check failed', e);
        }

        const existing = await findUserByUsernameLower(lower);

        if (action === 'register') {
            if (existing) return res.status(200).json({ ok: false, error: 'Username already taken. Try logging in.' });
            const hash = await hashPassword(password);
            const created = await createUserInDb({ username: usernameTrimmed, username_lower: lower, password_hash: hash, avatar: avatar || null });
            return res.status(200).json({ ok: true, action: 'registered', message: 'Account created successfully', user: sanitizeUserFromDb(created) });
        }

        if (existing) {
            const match = await verifyPassword(password, existing.password_hash);
            if (!match) return res.status(200).json({ ok: false, error: 'Invalid password. Please try again.' });
            const updated = await updateUserOnLogin(existing.id, { avatar: avatar || null });
            const userToReturn = updated || existing;
            if (avatar) userToReturn.avatar = avatar;
            return res.status(200).json({ ok: true, action: 'login', message: 'Login successful', user: sanitizeUserFromDb(userToReturn) });
        }

        // Auto-register
        const hash = await hashPassword(password);
        const created = await createUserInDb({ username: usernameTrimmed, username_lower: lower, password_hash: hash, avatar: avatar || null });
        return res.status(200).json({ ok: true, action: 'registered', message: 'Account created successfully', user: sanitizeUserFromDb(created) });

    } catch (err) {
        console.error('auth.js supabase error:', err);
        if (err.message && err.message.includes('SUPABASE')) {
            return res.status(500).json({ ok: false, error: 'Server not configured: ' + err.message });
        }
        return res.status(500).json({ ok: false, error: 'Internal server error: ' + err.message });
    }
}
