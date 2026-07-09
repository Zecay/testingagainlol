// /api/profile.js - Small, cacheable profile lookup for Realtime presence.
// Position packets contain only an avatar fingerprint. Clients fetch the full avatar
// at most once when a player joins or changes profile.

import { findUserByUsernameLower } from './_lib/supabase.js';

function avatarFingerprint(value) {
    if (!value || typeof value !== 'string') return '';
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16) + '-' + value.length;
}

function validUsername(value) {
    return typeof value === 'string' && value.trim().length >= 3 &&
        value.trim().length <= 25 && /^[a-zA-Z0-9_ \-]+$/.test(value.trim());
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // The response is keyed by immutable avatarHash on the client. A short public
    // cache removes repeat DB reads while still allowing profile changes to appear.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    try {
        let username = req.query?.username || '';
        try { username = decodeURIComponent(username); } catch {}
        if (!validUsername(username)) {
            return res.status(400).json({ ok: false, error: 'Invalid username' });
        }

        const user = await findUserByUsernameLower(username.trim().toLowerCase());
        if (!user) return res.status(404).json({ ok: false, error: 'Profile not found' });
        const avatar = typeof user.avatar === 'string' ? user.avatar : null;
        return res.status(200).json({
            ok: true,
            username: user.username,
            avatar,
            avatarHash: avatarFingerprint(avatar)
        });
    } catch (error) {
        console.error('profile lookup failed', error);
        return res.status(500).json({ ok: false, error: 'Profile lookup failed' });
    }
}
