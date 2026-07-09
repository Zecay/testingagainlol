// api/_lib/supabase.js - Supabase client & user DB helpers
// Tables:
// users, bans, kicks
/*
-- Run in Supabase SQL Editor:
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

create index if not exists users_lower_idx on users (username_lower);
create index if not exists bans_lower_idx on bans (username_lower);
create index if not exists kicks_lower_idx on kicks (username_lower);

-- Give admin to specific accounts:
-- update users set is_admin = true where username_lower in ('zecay','cz2rek');
*/

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;

export function getSupabaseClient() {
    if (supabase) return supabase;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. Set them in Vercel dashboard.');
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });
    return supabase;
}

export async function findUserByUsernameLower(usernameLower) {
    const client = getSupabaseClient();
    const { data, error } = await client
        .from('users')
        .select('*')
        .eq('username_lower', usernameLower)
        .limit(1)
        .maybeSingle();
    if (error) {
        console.error('Supabase find error:', error);
        throw new Error('Database error: ' + error.message);
    }
    return data || null;
}

export async function createUserInDb({ username, username_lower, password_hash, avatar }) {
    const client = getSupabaseClient();
    const now = Date.now();
    const isAdminList = ['zecay', 'cz2rek'];
    const isAdmin = isAdminList.includes(username_lower);
    const row = {
        username: username.trim(),
        username_lower: username_lower,
        password_hash,
        avatar: avatar || null,
        created_at: now,
        last_login: now,
        login_count: 1,
        is_admin: isAdmin
    };
    const { data, error } = await client
        .from('users')
        .insert(row)
        .select('*')
        .single();
    if (error) {
        if (error.code === '23505') {
            throw new Error('Username already taken');
        }
        console.error('Supabase insert error:', error);
        throw new Error('Database error: ' + error.message);
    }
    return data;
}

export async function updateUserOnLogin(id, { avatar } = {}) {
    const client = getSupabaseClient();
    const { data: existing } = await client.from('users').select('login_count').eq('id', id).single();
    const newCount = (existing?.login_count || 0) + 1;
    const updates = {
        last_login: Date.now(),
        login_count: newCount
    };
    if (avatar) updates.avatar = avatar;

    const { data, error } = await client
        .from('users')
        .update(updates)
        .eq('id', id)
        .select('*')
        .single();
    if (error) {
        console.error('Supabase update error:', error);
        return null;
    }
    return data;
}

export function sanitizeUserFromDb(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        displayName: user.username,
        username_lower: user.username_lower,
        avatar: user.avatar || null,
        created_at: user.created_at,
        last_login: user.last_login,
        login_count: user.login_count,
        is_admin: !!user.is_admin
    };
}

// --- Admin checks ---

export async function isUserAdmin(usernameLower) {
    if (!usernameLower) return false;
    const ADMIN_HARDCODED = ['zecay', 'cz2rek'];
    if (ADMIN_HARDCODED.includes(usernameLower)) return true;
    try {
        const user = await findUserByUsernameLower(usernameLower);
        return !!(user && user.is_admin);
    } catch {
        return false;
    }
}

// --- Bans ---

export async function isUserBanned(usernameLower) {
    const client = getSupabaseClient();
    const { data, error } = await client
        .from('bans')
        .select('*')
        .eq('username_lower', usernameLower)
        .limit(1)
        .maybeSingle();
    if (error) {
        console.error('Ban check error', error);
        return null;
    }
    if (!data) return null;
    // Check expiry
    if (data.expires_at && Date.now() > data.expires_at) {
        // Expired, auto unban
        await client.from('bans').delete().eq('username_lower', usernameLower);
        return null;
    }
    return data;
}

export async function banUser({ username, username_lower, banned_by, reason }) {
    const client = getSupabaseClient();
    const now = Date.now();
    const row = {
        username_lower,
        username,
        banned_by: banned_by || 'system',
        reason: reason || 'Banned by admin',
        banned_at: now,
        expires_at: null
    };
    const { data, error } = await client
        .from('bans')
        .upsert(row, { onConflict: 'username_lower' })
        .select('*')
        .single();
    if (error) throw new Error('Ban failed: ' + error.message);
    return data;
}

export async function unbanUser(usernameLower) {
    const client = getSupabaseClient();
    const { error } = await client.from('bans').delete().eq('username_lower', usernameLower);
    if (error) throw new Error('Unban failed: ' + error.message);
    return true;
}

export async function listBans() {
    const client = getSupabaseClient();
    const { data, error } = await client.from('bans').select('*').order('banned_at', { ascending: false }).limit(100);
    if (error) throw new Error('List bans failed: ' + error.message);
    return data || [];
}

// --- Kicks (for cross-instance kick) ---

export async function kickUserRecord({ username_lower, kicked_by }) {
    const client = getSupabaseClient();
    const row = {
        username_lower,
        kicked_by: kicked_by || 'system',
        kicked_at: Date.now()
    };
    const { error } = await client.from('kicks').insert(row);
    if (error) console.warn('Kick record failed', error);
    // Also cleanup old kicks > 60s
    const cutoff = Date.now() - 60000;
    await client.from('kicks').delete().lt('kicked_at', cutoff);
}

export async function wasRecentlyKicked(usernameLower, sinceMs = 15000) {
    const client = getSupabaseClient();
    const cutoff = Date.now() - sinceMs;
    const { data } = await client.from('kicks').select('*').eq('username_lower', usernameLower).gt('kicked_at', cutoff).limit(1).maybeSingle();
    return !!data;
}
