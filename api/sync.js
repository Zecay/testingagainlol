// /api/sync.js – Vercel Serverless Function
// Multiplayer sync optimized for smooth movement:
// - Positions every poll (tiny payload)
// - Avatars only when version changes / client asks
// - Single session per username, ban/kick, chat
//
// DROP-IN: replace your existing /api/sync.js with this file.
// Optional sibling: ./_lib/supabase.js (same as before)

let players = {};
let chatBuffer = [];
const MAX_CHAT = 40;
const PLAYER_TIMEOUT = 12000; // drop faster so ghosts disappear
const SETTINGS_TIMEOUT = 1000 * 60 * 60;
const MAX_POS = 5000;
let chatCounter = 0;

// Persist settings across brief disconnects inside same instance
let avatarStore = {}; // id -> { avatar, ver, ts }
let nameStore = {};   // id -> { username, displayName, ts }
let globalAvatarVer = 1;

// Ban/kick caches
let banCache = {}; // lower -> { banned, data, ts }
const BAN_CACHE_TTL = 2000;
let banListCache = { bans: new Map(), ts: 0, ttl: 5000 };
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
    // Keep smaller than before so memory/bandwidth stay sane
    if (str.length > 120000) return false;
    if (str.length < 10) return false;
    return (str.startsWith('data:image/') || str.startsWith('https://') || str.startsWith('http://'));
}

function r2(n) {
    // 2 decimals is plenty for movement and shrinks JSON a lot
    return Math.round(n * 100) / 100;
}

function cleanup() {
    const now = Date.now();
    for (const id in players) {
        if (now - players[id].lastSeen > PLAYER_TIMEOUT) {
            const p = players[id];
            if (p.avatar) avatarStore[id] = { avatar: p.avatar, ver: p.avatarVer || 1, ts: now };
            if (p.username || p.displayName) {
                nameStore[id] = {
                    username: p.username,
                    displayName: p.displayName || p.username,
                    ts: now
                };
            }
            delete players[id];
        }
    }
    for (const id in avatarStore) if (now - avatarStore[id].ts > SETTINGS_TIMEOUT) delete avatarStore[id];
    for (const id in nameStore) if (now - nameStore[id].ts > SETTINGS_TIMEOUT) delete nameStore[id];
    const cutoff = now - 12000;
    while (chatBuffer.length && chatBuffer[0].ts < cutoff) chatBuffer.shift();
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
        if (!error && data) {
            if (data.expires_at && now > data.expires_at) {
                await client.from('bans').delete().eq('username_lower', usernameLower);
                banCache[usernameLower] = { banned: false, data: null, ts: now };
                banListCache.bans.delete(usernameLower);
                return null;
            }
            banCache[usernameLower] = { banned: true, data, ts: now };
            banListCache.bans.set(usernameLower, data);
            return data;
        }
        if (!data) {
            banCache[usernameLower] = { banned: false, data: null, ts: now };
            return null;
        }
    } catch (e) {
        // Supabase optional
    }
    const mem = banCache[usernameLower];
    if (mem && mem.banned) return mem.data;
    return null;
}

async function refreshBanListCache() {
    const now = Date.now();
    if (now - banListCache.ts < banListCache.ttl) return banListCache.bans;
    try {
        const { getSupabaseClient } = await import('./_lib/supabase.js');
        const client = getSupabaseClient();
        const { data, error } = await client.from('bans').select('username_lower, username, reason, banned_by').limit(200);
        if (!error && data) {
            const map = new Map();
            for (const b of data) {
                map.set(b.username_lower, b);
                banCache[b.username_lower] = { banned: true, data: b, ts: now };
            }
            banListCache = { bans: map, ts: now, ttl: 10000 };
            return map;
        }
    } catch (e) {}
    const map = new Map();
    for (const k in banCache) {
        if (banCache[k].banned) map.set(k, banCache[k].data);
    }
    banListCache = { bans: map, ts: now, ttl: 10000 };
    return map;
}

async function checkIsAdminSupabase(usernameLower) {
    try {
        const { isUserAdmin } = await import('./_lib/supabase.js');
        return await isUserAdmin(usernameLower);
    } catch {
        const hard = ['zecay', 'cz2rek'];
        return hard.includes(usernameLower);
    }
}

async function tryStoreChatSupabase(chatObj) {
    try {
        const { getSupabaseClient } = await import('./_lib/supabase.js');
        const client = getSupabaseClient();
        // Do NOT store avatar blobs in chat table — too heavy
        await client.from('chats').insert({
            player_id: chatObj.id,
            username: chatObj.username,
            avatar: null,
            text: chatObj.text,
            ts: chatObj.ts
        });
    } catch (e) {}
}

async function tryGetRecentChatsSupabase(sinceTs) {
    try {
        const { getSupabaseClient } = await import('./_lib/supabase.js');
        const client = getSupabaseClient();
        const { data, error } = await client
            .from('chats')
            .select('id, player_id, username, text, ts')
            .gt('ts', sinceTs)
            .order('ts', { ascending: true })
            .limit(30);
        if (!error && data && data.length > 0) {
            return data.map(d => ({
                mid: d.id,
                id: d.player_id,
                username: d.username,
                avatar: null,
                text: d.text,
                ts: d.ts
            }));
        }
    } catch (e) {}
    return [];
}

function parseKnownAvatars(raw) {
    // Client can send: knownAvatars=id:ver,id:ver
    const map = Object.create(null);
    if (!raw || typeof raw !== 'string') return map;
    let s = raw;
    try { s = decodeURIComponent(raw); } catch {}
    const parts = s.split(',');
    for (const part of parts) {
        const [pid, verStr] = part.split(':');
        if (!pid) continue;
        const ver = parseInt(verStr, 10);
        if (Number.isFinite(ver)) map[pid] = ver;
    }
    return map;
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

        let {
            id, username, name, x, y, z, chat, displayName, avatar,
            adminAction, target, reason,
            // NEW optional client params
            knownAvatars, needAvatars, full
        } = p;

        // full=1 or needAvatars=1 => include avatar blobs the client doesn't know yet
        const includeAvatars = full === '1' || full === 1 || full === true
            || needAvatars === '1' || needAvatars === 1 || needAvatars === true;

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
        const known = parseKnownAvatars(knownAvatars);

        if (!players[id]) {
            players[id] = {
                x: 0, y: 0, z: 0,
                username: null,
                displayName: null,
                avatar: null,
                avatarVer: 0,
                approved: false,
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                playtime: 0,
                playtimeLastUpdate: now,
                lastSeen: now
            };
            if (avatarStore[id] && isValidAvatar(avatarStore[id].avatar)) {
                players[id].avatar = avatarStore[id].avatar;
                players[id].avatarVer = avatarStore[id].ver || 1;
            }
            if (nameStore[id]) {
                if (nameStore[id].username) {
                    players[id].username = nameStore[id].username;
                    players[id].approved = true;
                }
                if (nameStore[id].displayName) players[id].displayName = nameStore[id].displayName;
            }
        }

        const pl = players[id];
        pl.lastSeen = now;
        if (pl.playtimeLastUpdate) pl.playtime += now - pl.playtimeLastUpdate;
        pl.playtimeLastUpdate = now;

        // Positions
        const px = parseFloat(x), py = parseFloat(y), pz = parseFloat(z);
        if (Number.isFinite(px)) pl.x = r2(Math.max(-MAX_POS, Math.min(MAX_POS, px)));
        if (Number.isFinite(py)) pl.y = r2(Math.max(-MAX_POS, Math.min(MAX_POS, py)));
        if (Number.isFinite(pz)) pl.z = r2(Math.max(-MAX_POS, Math.min(MAX_POS, pz)));

        let usernameRejected = null;
        if (typeof username === 'string' && username.trim()) {
            const r = isValidUsername(username);
            if (r.ok) {
                const trimmed = username.trim();
                const lower = trimmed.toLowerCase();

                const banned = await checkIfBannedSupabase(lower);
                if (banned) {
                    delete players[id];
                    return res.status(200).json({
                        ok: false, banned: true, error: 'Banned',
                        reason: banned.reason || 'Banned by admin', banInfo: banned
                    });
                }

                // Single session per username
                for (const [otherId, other] of Object.entries(players)) {
                    if (otherId !== id && other.username && other.username.toLowerCase() === lower) {
                        delete players[otherId];
                        kickCache[lower] = now;
                    }
                }

                if (!pl.approved || pl.username !== trimmed) {
                    pl.username = trimmed;
                    if (!pl.displayName) pl.displayName = trimmed;
                    pl.approved = true;
                    nameStore[id] = {
                        username: pl.username,
                        displayName: pl.displayName || trimmed,
                        ts: now
                    };
                }
            } else if (!pl.approved) {
                usernameRejected = r.reason;
            }
        }

        if (pl.approved) {
            if (typeof displayName === 'string' && displayName.trim()) {
                const r = isValidUsername(displayName);
                if (r.ok) {
                    const trimmed = displayName.trim();
                    pl.displayName = trimmed;
                    nameStore[id] = {
                        username: pl.username || trimmed,
                        displayName: trimmed,
                        ts: now
                    };
                }
            }
            if (isValidAvatar(avatar)) {
                // Only bump version if content changed
                if (pl.avatar !== avatar) {
                    pl.avatar = avatar;
                    pl.avatarVer = (pl.avatarVer || 0) + 1;
                    if (pl.avatarVer < 1) pl.avatarVer = 1;
                    avatarStore[id] = { avatar, ver: pl.avatarVer, ts: now };
                }
            }
        } else {
            if (isValidAvatar(avatar)) {
                if (pl.avatar !== avatar) {
                    pl.avatar = avatar;
                    pl.avatarVer = (pl.avatarVer || 0) + 1;
                }
                avatarStore[id] = { avatar, ver: pl.avatarVer || 1, ts: now };
            }
        }

        // -------- Admin actions (unchanged behavior) --------
        if (adminAction && typeof adminAction === 'string') {
            const requesterLower = pl.username ? pl.username.toLowerCase() : null;
            if (!requesterLower) return res.status(200).json({ ok: false, error: 'Not authenticated' });
            const isAdmin = await checkIsAdminSupabase(requesterLower);
            if (!isAdmin) return res.status(200).json({ ok: false, error: 'Not admin - action denied' });
            const targetLower = target ? target.trim().toLowerCase() : null;
            const targetOriginal = target ? target.trim() : null;
            if (!targetLower) return res.status(200).json({ ok: false, error: 'Missing target username' });
            if (targetLower === requesterLower) return res.status(200).json({ ok: false, error: 'Cannot target yourself' });

            if (adminAction === 'kick') {
                let kickedCount = 0;
                for (const [pid, pdata] of Object.entries(players)) {
                    if (pdata.username && pdata.username.toLowerCase() === targetLower) {
                        delete players[pid];
                        kickedCount++;
                    }
                }
                kickCache[targetLower] = now;
                try {
                    const { getSupabaseClient } = await import('./_lib/supabase.js');
                    const client = getSupabaseClient();
                    await client.from('kicks').insert({
                        username_lower: targetLower,
                        kicked_by: pl.username,
                        kicked_at: now
                    });
                } catch {}
                chatBuffer.push({
                    mid: ++chatCounter, id: 'system', username: 'System', avatar: null,
                    text: `${targetOriginal} was kicked by ${pl.username}`, ts: now
                });
                const retryAfter = 15;
                const kickedUntil = now + retryAfter * 1000;
                return res.status(200).json({
                    ok: true, action: 'kick', target: targetOriginal, kickedCount,
                    message: `Kicked ${kickedCount} session(s) of ${targetOriginal}`,
                    retryAfter, kickedUntil
                });
            }

            if (adminAction === 'ban') {
                banCache[targetLower] = {
                    banned: true,
                    data: {
                        username: targetOriginal,
                        reason: reason || 'Banned',
                        banned_by: pl.username,
                        username_lower: targetLower
                    },
                    ts: now
                };
                banListCache.bans.set(targetLower, {
                    username_lower: targetLower,
                    username: targetOriginal,
                    reason: reason || 'Banned',
                    banned_by: pl.username
                });
                for (const [pid, pdata] of Object.entries(players)) {
                    if (pdata.username && pdata.username.toLowerCase() === targetLower) delete players[pid];
                }
                try {
                    const { banUser } = await import('./_lib/supabase.js');
                    await banUser({
                        username: targetOriginal,
                        username_lower: targetLower,
                        banned_by: pl.username,
                        reason: reason || 'Banned by admin'
                    });
                } catch (e) {
                    console.warn('Supabase ban failed, in-memory ban set', e.message);
                }
                chatBuffer.push({
                    mid: ++chatCounter, id: 'system', username: 'System', avatar: null,
                    text: `${targetOriginal} was banned by ${pl.username}`, ts: now
                });
                return res.status(200).json({
                    ok: true, action: 'ban', target: targetOriginal,
                    message: `${targetOriginal} banned`
                });
            }

            if (adminAction === 'unban') {
                delete banCache[targetLower];
                banListCache.bans.delete(targetLower);
                try {
                    const { unbanUser } = await import('./_lib/supabase.js');
                    await unbanUser(targetLower);
                } catch (e) {
                    console.warn('Supabase unban failed, in-memory unban done', e.message);
                }
                return res.status(200).json({
                    ok: true, action: 'unban', target: targetOriginal,
                    message: `${targetOriginal} unbanned`
                });
            }
            return res.status(200).json({ ok: false, error: 'Unknown adminAction' });
        }

        // Kick / ban rejoin guards
        if (pl.username) {
            const lower = pl.username.toLowerCase();
            try {
                const { wasRecentlyKicked } = await import('./_lib/supabase.js');
                if (await wasRecentlyKicked(lower, 15000)) {
                    const isAdmin = await checkIsAdminSupabase(lower);
                    if (!isAdmin) {
                        delete players[id];
                        return res.status(200).json({
                            ok: false, kicked: true,
                            error: 'You have been kicked by an admin',
                            retryAfter: 15, kickedUntil: now + 15000
                        });
                    }
                }
            } catch {}
            const bannedNow = await checkIfBannedSupabase(lower);
            if (bannedNow) {
                delete players[id];
                return res.status(200).json({
                    ok: false, banned: true, error: 'Banned',
                    reason: bannedNow.reason, banInfo: bannedNow
                });
            }
        }

        // Chat
        let chatBlocked = false;
        if (typeof chat === 'string' && chat.trim() && pl.approved) {
            const clean = chat.trim().slice(0, 140);
            if (clean) {
                if (isBad(clean)) chatBlocked = true;
                else {
                    const chatObj = {
                        mid: ++chatCounter,
                        id,
                        username: pl.displayName || pl.username || 'Player',
                        // never put base64 avatar on every chat message
                        avatar: null,
                        text: clean,
                        ts: Date.now()
                    };
                    chatBuffer.push(chatObj);
                    if (chatBuffer.length > MAX_CHAT) chatBuffer.shift();
                    tryStoreChatSupabase(chatObj);
                }
            }
        }

        const bannedMap = await refreshBanListCache();

        // -------- Build LIGHT player list (positions always; avatars rarely) --------
        const otherPlayers = {};
        for (const [pid, pdata] of Object.entries(players)) {
            if (pid === id) continue;
            if (!pdata.approved) continue;
            if (pdata.username) {
                const pLower = pdata.username.toLowerCase();
                if (bannedMap.has(pLower) || (banCache[pLower] && banCache[pLower].banned)) continue;
            }

            const ver = pdata.avatarVer || 0;
            const entry = {
                username: pdata.username,
                displayName: pdata.displayName || pdata.username,
                name: pdata.displayName || pdata.username,
                x: pdata.x,
                y: pdata.y,
                z: pdata.z,
                color: pdata.color,
                playtime: pdata.playtime,
                avatarVer: ver
            };

            // Include avatar blob only if client doesn't already have this version
            const clientVer = known[pid] || 0;
            const av = pdata.avatar || (avatarStore[pid] ? avatarStore[pid].avatar : null);
            if (av && (includeAvatars || clientVer < ver)) {
                entry.avatar = av;
            }
            // else omit avatar field entirely => tiny JSON

            otherPlayers[pid] = entry;
        }

        // Chat: last ~10s, no avatar blobs
        let recentChat = chatBuffer
            .filter(m => m.ts > now - 10000 && m.id !== id)
            .map(m => ({
                mid: m.mid,
                id: m.id,
                username: m.username,
                avatar: null,
                text: m.text,
                ts: m.ts
            }));

        try {
            const supabaseChats = await tryGetRecentChatsSupabase(now - 10000);
            if (supabaseChats.length > 0) {
                const existingKeys = new Set(recentChat.map(c => `${c.username}:${c.text}:${Math.floor(c.ts / 2000)}`));
                const existingMids = new Set(recentChat.map(c => c.mid));
                for (const sc of supabaseChats) {
                    if (sc.id === id) continue;
                    if (sc.ts < now - 10000) continue;
                    const key = `${sc.username}:${sc.text}:${Math.floor(sc.ts / 2000)}`;
                    if (existingMids.has(sc.mid) || existingKeys.has(key)) continue;
                    recentChat.push(sc);
                }
                recentChat.sort((a, b) => a.ts - b.ts);
                if (recentChat.length > 40) recentChat = recentChat.slice(-40);
            }
        } catch {}

        // Self avatar: only return when client doesn't know current version
        // (or on explicit full/needAvatars). Keeps normal polls tiny.
        const myVer = pl.avatarVer || 0;
        const myKnown = known[id] || 0;
        let myAvatar = null;
        if (pl.avatar && (includeAvatars || myKnown < myVer)) {
            myAvatar = pl.avatar;
        } else if (!pl.avatar && avatarStore[id] && (includeAvatars || myKnown < (avatarStore[id].ver || 0))) {
            myAvatar = avatarStore[id].avatar;
        }

        const isAdmin = pl.username ? await checkIsAdminSupabase(pl.username.toLowerCase()) : false;

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            myPlaytime: pl.playtime,
            displayName: pl.displayName || (nameStore[id] ? nameStore[id].displayName : null),
            avatar: myAvatar,
            avatarVer: myVer,
            is_admin: isAdmin,
            players: otherPlayers,
            chat: recentChat
        });

    } catch (err) {
        console.error('sync error', err);
        res.status(500).json({ ok: false, error: err.message });
    }
}
