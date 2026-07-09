// api/_lib/supabase.js - Supabase client & user DB helpers
// Stores accounts securely in Supabase Postgres table `users`
// Table SQL you created:
/*
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
-- Also run: create extension if not exists pgcrypto;
*/

import { createClient } from '@supabase/supabase-js';

// Get env vars (set in Vercel dashboard -> Settings -> Environment Variables)
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
    const row = {
        username: username.trim(),
        username_lower: username_lower,
        password_hash,
        avatar: avatar || null,
        created_at: now,
        last_login: now,
        login_count: 1
    };
    const { data, error } = await client
        .from('users')
        .insert(row)
        .select('*')
        .single();
    if (error) {
        // Unique violation?
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
    const updates = {
        last_login: Date.now(),
        login_count: undefined // will increment via raw? We'll fetch then update
    };
    // For login_count we need to increment - do it with rpc or read then write
    // Simplest: fetch current, then update
    const { data: existing } = await client.from('users').select('login_count').eq('id', id).single();
    const newCount = (existing?.login_count || 0) + 1;
    updates.login_count = newCount;
    if (avatar) updates.avatar = avatar;

    const { data, error } = await client
        .from('users')
        .update(updates)
        .eq('id', id)
        .select('*')
        .single();
    if (error) {
        console.error('Supabase update error:', error);
        // Don't throw, login still succeeded
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
        login_count: user.login_count
    };
}
