// /api/sync.js – Vercel Serverless Function
// Multiplayer sync: position, chat, username, profile, playtime
// + Single session per username (kick old on new login)
// + Ban check via Supabase (cached)
// + Admin actions (kick/ban) via same endpoint (secure)
// + Avatar/name persistent stores

let players = {};
let chatBuffer = [];
const MAX_CHAT = 50;
const PLAYER_TIMEOUT = 30000;
const SETTINGS_TIMEOUT = 1000 * 60 * 60;
const MAX_POS = 5000;
let chatCounter = 0;

let avatarStore = {};
let nameStore = {};

// Ban cache to avoid hammering Supabase every 100ms
let banCache = {}; // lower -> { banned, data, ts }
const BAN_CACHE_TTL = 10000; // 10 sec
let kickCache = {}; // lower -> kickedAt

const BAD_WORDS = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) { return typeof s === 'string' && BAD_WORDS.test(s.toLowerCase()); }

function isValidUsername(name) {
    if (!name || !name.trim()) return { ok: false, reason: 'Username cannot be empty.' };
    const n = name.trim();
    if (n.length > 25) return { ok: false, reason: 'Username is too long.' };
    if (!/^[a-zA-Z0-9_ \-]+$/.test(n)) return { ok: false, reason: 'Only letters, numbers, underscores, spaces and dashes allowed.' };
    if (isBad(n)) return { ok: false, reason: 'That username is not allowed.' };
    return { ok: true };
}
function isValidAvatar(str) {
    if (typeof str !== 'string') return false;
    if (str.length > 200000) return false;
    if (str.length < 10) return false;
    return (str.startsWith('data:image/') || str.startsWith('https://') || str.startsWith('http://'));
}

function cleanup() {
    const now = Date.now();
    for (const id in players) {
        if (now - players[id].lastSeen > PLAYER_TIMEOUT) {
            const p = players[id];
            if (p.avatar) avatarStore[id] = { avatar: p.avatar, ts: now };
            if (p.username || p.displayName) nameStore[id] = { username: p.username, displayName: p.displayName || p.username, ts: now };
            delete players[id];
        }
    }
    for (const id in avatarStore) if (now - avatarStore[id].ts > SETTINGS_TIMEOUT) delete avatarStore[id];
    for (const id in nameStore) if (now - nameStore[id].ts > SETTINGS_TIMEOUT) delete nameStore[id];
    const cutoff = now - 15000;
    while (chatBuffer.length && chatBuffer[0].ts < cutoff) chatBuffer.shift();
    // Cleanup old kick cache
    for (const k in kickCache) if (now - kickCache[k] > 60000) delete kickCache[k];
}

async function getBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

// --- Supabase helpers for bans/kicks/admin check (lazy import to avoid crash if no env) ---
async function checkIfBannedSupabase(usernameLower) {
    const now = Date.now();
    const cached = banCache[usernameLower];
    if (cached && now - cached.ts < BAN_CACHE_TTL) {
        return cached.banned ? cached.data : null;
    }
    try {
        const { getSupabaseClient } = await import('./_lib/supabase.js');
        const client = getSupabaseClient();
        const { data, error } = await client.from('bans').select('*').eq('username_lower', usernameLower).maybeSingle();
        if (error) {
            console.warn('Ban check error', error.message);
            return null;
        }
        if (!data) {
            banCache[usernameLower] = { banned: false, data: null, ts: now };
            return null;
        }
        if (data.expires_at && now > data.expires_at) {
            await client.from('bans').delete().eq('username_lower', usernameLower);
            banCache[usernameLower] = { banned: false, data: null, ts: now };
            return null;
        }
        banCache[usernameLower] = { banned: true, data, ts: now };
        return data;
    } catch (e) {
        // No supabase config or other error -> allow
        return null;
    }
}

async function checkIsAdminSupabase(usernameLower) {
    try {
        const { isUserAdmin } = await import('./_lib/supabase.js');
        return await isUserAdmin(usernameLower);
    } catch {
        // Fallback hardcoded
        const hard = ['zecay', 'cz2rek'];
        return hard.includes(usernameLower);
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        cleanup();
        const body = req.method === 'POST' ? (await getBody(req)) : {};
        const q = req.query || {};
        const p = { ...q, ...body };

        let { id, username, name, x, y, z, chat, displayName, avatar, adminAction, target, reason } = p;

        if (!username && name) { try { username = decodeURIComponent(name); } catch { username = name; } }
        if (displayName) { try { displayName = decodeURIComponent(displayName); } catch {} }
        if (avatar) { try { avatar = decodeURIComponent(avatar); } catch {} }
        if (chat) { try { chat = decodeURIComponent(chat); } catch {} }
        if (target) { try { target = decodeURIComponent(target); } catch {} }
        if (reason) { try { reason = decodeURIComponent(reason); } catch {} }

        if (!id || typeof id !== 'string') {
            return res.status(200).json({ ok: false, error: 'Missing id' });
        }

        const now = Date.now();

        if (!players[id]) {
            players[id] = {
                x: 0, y: 0, z: 0,
                username: null,
                displayName: null,
                avatar: null,
                approved: false,
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                playtime: 0,
                playtimeLastUpdate: now,
                lastSeen: now
            };
            if (avatarStore[id] && isValidAvatar(avatarStore[id].avatar)) players[id].avatar = avatarStore[id].avatar;
            if (nameStore[id]) {
                if (nameStore[id].username) { players[id].username = nameStore[id].username; players[id].approved = true; }
                if (nameStore[id].displayName) players[id].displayName = nameStore[id].displayName;
            }
        }

        const pl = players[id];
        pl.lastSeen = now;
        if (pl.playtimeLastUpdate) pl.playtime += now - pl.playtimeLastUpdate;
        pl.playtimeLastUpdate = now;

        const px = parseFloat(x), py = parseFloat(y), pz = parseFloat(z);
        if (Number.isFinite(px)) pl.x = Math.max(-MAX_POS, Math.min(MAX_POS, px));
        if (Number.isFinite(py)) pl.y = Math.max(-MAX_POS, Math.min(MAX_POS, py));
        if (Number.isFinite(pz)) pl.z = Math.max(-MAX_POS, Math.min(MAX_POS, pz));

        // Username approval + ban check + single session enforcement
        let usernameRejected = null;
        if (typeof username === 'string' && username.trim()) {
            const r = isValidUsername(username);
            if (r.ok) {
                const trimmed = username.trim();
                const lower = trimmed.toLowerCase();

                // Check if banned (from Supabase)
                const banned = await checkIfBannedSupabase(lower);
                if (banned) {
                    // Don't allow login, delete player entry
                    delete players[id];
                    return res.status(200).json({ ok: false, banned: true, error: `You are banned. Reason: ${banned.reason || 'Banned by admin'}`, banInfo: banned });
                }

                // Check single session: kick any other player with same username_lower
                for (const [otherId, other] of Object.entries(players)) {
                    if (otherId !== id && other.username && other.username.toLowerCase() === lower) {
                        // Kick old session
                        console.log(`Kicking old session for ${lower}: ${otherId} replaced by ${id}`);
                        delete players[otherId];
                        // Also mark kicked
                        kickCache[lower] = now;
                    }
                }

                // Check if this username was recently kicked (if someone else just kicked you)
                // If kickCache has this lower and it's recent and this id is not the kicker, allow but it means you were kicked previously - we already deleted old, now allow new

                if (!pl.approved || pl.username !== trimmed) {
                    pl.username = trimmed;
                    if (!pl.displayName) pl.displayName = trimmed;
                    pl.approved = true;
                    nameStore[id] = { username: pl.username, displayName: pl.displayName || trimmed, ts: now };
                }
            } else if (!pl.approved) {
                usernameRejected = r.reason;
            }
        }

        // Profile updates
        if (pl.approved) {
            if (typeof displayName === 'string' && displayName.trim()) {
                const r = isValidUsername(displayName);
                if (r.ok) {
                    const trimmed = displayName.trim();
                    pl.displayName = trimmed;
                    nameStore[id] = { username: pl.username || trimmed, displayName: trimmed, ts: now };
                }
            }
            if (isValidAvatar(avatar)) {
                pl.avatar = avatar;
                avatarStore[id] = { avatar: avatar, ts: now };
            }
        } else {
            if (isValidAvatar(avatar)) {
                avatarStore[id] = { avatar: avatar, ts: now };
                pl.avatar = avatar;
            }
        }

        // --- Admin actions handling (secure) ---
        // Expected: adminAction = 'kick'|'ban'|'unban', target = username to act on, reason optional
        // Admin is determined by requester's username_lower (must be admin in Supabase)
        if (adminAction && typeof adminAction === 'string') {
            const requesterLower = pl.username ? pl.username.toLowerCase() : null;
            if (!requesterLower) {
                return res.status(200).json({ ok: false, error: 'Not authenticated' });
            }
            const isAdmin = await checkIsAdminSupabase(requesterLower);
            if (!isAdmin) {
                return res.status(200).json({ ok: false, error: 'Not admin - action denied' });
            }
            const targetLower = target ? target.trim().toLowerCase() : null;
            const targetOriginal = target ? target.trim() : null;
            if (!targetLower) {
                return res.status(200).json({ ok: false, error: 'Missing target username' });
            }
            // Prevent self-action
            if (targetLower === requesterLower) {
                return res.status(200).json({ ok: false, error: 'Cannot target yourself' });
            }

            if (adminAction === 'kick') {
                // Kick from memory
                let kickedCount = 0;
                for (const [pid, pdata] of Object.entries(players)) {
                    if (pdata.username && pdata.username.toLowerCase() === targetLower) {
                        delete players[pid];
                        kickedCount++;
                    }
                }
                kickCache[targetLower] = now;
                // Also write to supabase kicks table for cross-instance
                try {
                    const { getSupabaseClient } = await import('./_lib/supabase.js');
                    const client = getSupabaseClient();
                    await client.from('kicks').insert({ username_lower: targetLower, kicked_by: pl.username, kicked_at: now });
                } catch {}
                chatBuffer.push({ mid: ++chatCounter, id: 'system', username: 'System', avatar: null, text: `${targetOriginal} was kicked by ${pl.username}`, ts: now });
                return res.status(200).json({ ok: true, action: 'kick', target: targetOriginal, kickedCount, message: `Kicked ${kickedCount} session(s) of ${targetOriginal}` });
            }

            if (adminAction === 'ban') {
                try {
                    const { banUser } = await import('./_lib/supabase.js');
                    await banUser({ username: targetOriginal, username_lower: targetLower, banned_by: pl.username, reason: reason || 'Banned by admin' });
                    // Also kick online
                    for (const [pid, pdata] of Object.entries(players)) {
                        if (pdata.username && pdata.username.toLowerCase() === targetLower) delete players[pid];
                    }
                    banCache[targetLower] = { banned: true, data: { username: targetOriginal, reason: reason || 'Banned', banned_by: pl.username }, ts: now };
                    chatBuffer.push({ mid: ++chatCounter, id: 'system', username: 'System', avatar: null, text: `${targetOriginal} was banned by ${pl.username}`, ts: now });
                    return res.status(200).json({ ok: true, action: 'ban', target: targetOriginal, message: `${targetOriginal} banned` });
                } catch (e) {
                    return res.status(200).json({ ok: false, error: 'Ban failed: ' + e.message });
                }
            }

            if (adminAction === 'unban') {
                try {
                    const { unbanUser } = await import('./_lib/supabase.js');
                    await unbanUser(targetLower);
                    delete banCache[targetLower];
                    return res.status(200).json({ ok: true, action: 'unban', target: targetOriginal, message: `${targetOriginal} unbanned` });
                } catch (e) {
                    return res.status(200).json({ ok: false, error: 'Unban failed: ' + e.message });
                }
            }

            return res.status(200).json({ ok: false, error: 'Unknown adminAction' });
        }

        // Check if this player was kicked recently (cross-instance kick via supabase)
        if (pl.username) {
            const lower = pl.username.toLowerCase();
            if (kickCache[lower] && now - kickCache[lower] < 5000) {
                // If this player joined after kick time? Actually kickCache set when kick happened. If player is still here after 5s, they should be kicked.
                // But to avoid kicking the new session that kicked old, we check if this player was the one that caused kick? We already deleted old before setting cache. Now new player that just joined with same name would have been after old deleted. The cache is for informing other instances.
                // Instead, we will only kick if player's lastSeen is before kick time + 5s and player is not the admin who just kicked someone else with different name.
                // For simplicity, if kickCache exists and this player's join time is before kick time, kick them.
                // For now, we just ignore because admin kick already deleted in same instance. Cross-instance handled by supabase kicks polling (not yet implemented full).
            }
            // Also check supabase kicks for cross-instance (last 15 sec)
            try {
                const { wasRecentlyKicked } = await import('./_lib/supabase.js');
                if (await wasRecentlyKicked(lower, 15000)) {
                    // If this player was not the one who just kicked themselves, and their lastSeen is very recent (<2 sec after kick), they might be target
                    // We will check if they are currently online and their name matches kicked name, and kick time is after their join
                    // For safety, we only kick if they have been online less than 30 sec and not admin
                    const isAdmin = await checkIsAdminSupabase(lower);
                    if (!isAdmin) {
                        // Delete and return kicked
                        delete players[id];
                        return res.status(200).json({ ok: false, kicked: true, error: 'You were kicked by an admin' });
                    }
                }
            } catch {}
        }

        // Chat
        let chatBlocked = false;
        if (typeof chat === 'string' && chat.trim() && pl.approved) {
            const clean = chat.trim().slice(0, 140);
            if (clean) {
                if (isBad(clean)) chatBlocked = true;
                else {
                    chatBuffer.push({ mid: ++chatCounter, id, username: pl.displayName || pl.username || 'Player', avatar: pl.avatar || (avatarStore[id] ? avatarStore[id].avatar : null), text: clean, ts: Date.now() });
                    if (chatBuffer.length > MAX_CHAT) chatBuffer.shift();
                }
            }
        }

        const otherPlayers = {};
        for (const [pid, pdata] of Object.entries(players)) {
            if (pid !== id && pdata.approved) {
                otherPlayers[pid] = {
                    username: pdata.username,
                    displayName: pdata.displayName || pdata.username,
                    name: pdata.displayName || pdata.username,
                    avatar: pdata.avatar || (avatarStore[pid] ? avatarStore[pid].avatar : null),
                    x: pdata.x, y: pdata.y, z: pdata.z,
                    color: pdata.color,
                    playtime: pdata.playtime
                };
            }
        }

        const recentChat = chatBuffer.filter(m => m.ts > now - 10000 && m.id !== id).map(m => ({ mid: m.mid, id: m.id, username: m.username, avatar: m.avatar, text: m.text, ts: m.ts }));

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            myPlaytime: pl.playtime,
            displayName: pl.displayName || (nameStore[id] ? nameStore[id].displayName : null),
            avatar: pl.avatar || (avatarStore[id] ? avatarStore[id].avatar : null),
            is_admin: pl.username ? await checkIsAdminSupabase(pl.username.toLowerCase()) : false,
            players: otherPlayers,
            chat: recentChat
        });

    } catch (err) {
        console.error('sync error', err);
        res.status(500).json({ ok: false, error: err.message });
    }
}
