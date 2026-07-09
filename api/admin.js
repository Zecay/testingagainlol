// /api/admin.js - Secure admin panel backend
// Only users with is_admin=true or hardcoded list Zecay/Cz2rek can use
// Supports: ban, unban, kick, listBans, listPlayers (via sync memory? bans only)
// Security: Every request checks admin via Supabase, not just frontend

import { isUserAdmin, banUser, unbanUser, listBans, kickUserRecord } from './_lib/supabase.js';

function isValidUsername(name) {
    if (!name || !name.trim()) return false;
    return /^[a-zA-Z0-9_ \-]+$/.test(name.trim()) && name.trim().length >=3 && name.trim().length <=25;
}

async function getBody(req) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length>0) return req.body;
    return new Promise(resolve => {
        let data='';
        req.on('data', c=>data+=c);
        req.on('end', ()=>{
            try { if(!data) resolve({}); else resolve(JSON.parse(data)); } catch { resolve({}); }
        });
        req.on('error', ()=>resolve({}));
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

        let { adminUsername, adminId, action, target, reason } = p;
        if (adminUsername) { try { adminUsername = decodeURIComponent(adminUsername); } catch {} }
        if (target) { try { target = decodeURIComponent(target); } catch {} }

        if (!adminUsername) {
            return res.status(200).json({ ok: false, error: 'Missing adminUsername - you must be logged in' });
        }

        const adminLower = adminUsername.trim().toLowerCase();
        const isAdmin = await isUserAdmin(adminLower);
        if (!isAdmin) {
            return res.status(200).json({ ok: false, error: 'Access denied - not admin' });
        }

        // No action -> return admin info + ban list
        if (!action) {
            const bans = await listBans();
            return res.status(200).json({ ok: true, isAdmin: true, adminUsername, bans });
        }

        if (action === 'listBans') {
            const bans = await listBans();
            return res.status(200).json({ ok: true, bans });
        }

        if (!target || !isValidUsername(target)) {
            return res.status(200).json({ ok: false, error: 'Invalid target username' });
        }

        const targetLower = target.trim().toLowerCase();
        const targetOriginal = target.trim();

        if (targetLower === adminLower) {
            return res.status(200).json({ ok: false, error: 'Cannot target yourself' });
        }

        if (action === 'ban') {
            const banned = await banUser({ username: targetOriginal, username_lower: targetLower, banned_by: adminUsername, reason: reason || 'Banned by admin' });
            return res.status(200).json({ ok: true, action: 'ban', target: targetOriginal, ban: banned });
        }

        if (action === 'unban') {
            await unbanUser(targetLower);
            return res.status(200).json({ ok: true, action: 'unban', target: targetOriginal });
        }

        if (action === 'kick') {
            await kickUserRecord({ username_lower: targetLower, kicked_by: adminUsername });
            return res.status(200).json({ ok: true, action: 'kick', target: targetOriginal, message: `Kick recorded for ${targetOriginal} - will be kicked from game within 15s` });
        }

        return res.status(200).json({ ok: false, error: 'Unknown action' });

    } catch (err) {
        console.error('admin.js error', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
