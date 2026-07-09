// /api/sync.js – Vercel Serverless Function
// Multiplayer sync: position, chat, username, profile, playtime
// FIXED: chat dedup with mid, avatar sync for external URLs
// IMPROVED: persistent settings store for name/avatar (survives disconnect, 1h)
// In-memory only (resets on cold start, but settings kept longer)

let players = {};
let chatBuffer = [];
const MAX_CHAT = 50;
const PLAYER_TIMEOUT = 30000;
const SETTINGS_TIMEOUT = 1000 * 60 * 60; // keep settings 1 hour even if player leaves
const MAX_POS = 5000;
let chatCounter = 0;

// Persistent stores (not cleared on player timeout, only after 1h)
let avatarStore = {}; // id -> { avatar, ts }
let nameStore = {}; // id -> { username, displayName, ts }

const BAD_WORDS = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) {
    return typeof s === 'string' && BAD_WORDS.test(s.toLowerCase());
}

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
    // Allow data:image base64 AND https http URLs (for template webp etc)
    return (
        str.startsWith('data:image/') ||
        str.startsWith('https://') ||
        str.startsWith('http://')
    );
}

function cleanup() {
    const now = Date.now();
    for (const id in players) {
        if (now - players[id].lastSeen > PLAYER_TIMEOUT) {
            // Before deleting, save settings to persistent store
            const p = players[id];
            if (p.avatar) avatarStore[id] = { avatar: p.avatar, ts: now };
            if (p.username || p.displayName) {
                nameStore[id] = { username: p.username, displayName: p.displayName || p.username, ts: now };
            }
            delete players[id];
        }
    }
    // Clean old settings after 1 hour
    for (const id in avatarStore) {
        if (now - avatarStore[id].ts > SETTINGS_TIMEOUT) delete avatarStore[id];
    }
    for (const id in nameStore) {
        if (now - nameStore[id].ts > SETTINGS_TIMEOUT) delete nameStore[id];
    }
    const cutoff = now - 15000;
    while (chatBuffer.length && chatBuffer[0].ts < cutoff) chatBuffer.shift();
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

        let { id, username, name, x, y, z, chat, displayName, avatar } = p;

        if (!username && name) {
            try { username = decodeURIComponent(name); } catch { username = name; }
        }
        if (displayName) {
            try { displayName = decodeURIComponent(displayName); } catch {}
        }
        if (avatar) {
            try { avatar = decodeURIComponent(avatar); } catch {}
        }
        if (chat) {
            try { chat = decodeURIComponent(chat); } catch {}
        }

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
            // Restore from persistent stores if available
            if (avatarStore[id] && isValidAvatar(avatarStore[id].avatar)) {
                players[id].avatar = avatarStore[id].avatar;
            }
            if (nameStore[id]) {
                if (nameStore[id].username) {
                    players[id].username = nameStore[id].username;
                    players[id].approved = true;
                }
                if (nameStore[id].displayName) {
                    players[id].displayName = nameStore[id].displayName;
                }
            }
        }

        const pl = players[id];
        pl.lastSeen = now;

        // Update playtime
        if (pl.playtimeLastUpdate) {
            pl.playtime += now - pl.playtimeLastUpdate;
        }
        pl.playtimeLastUpdate = now;

        // Position sync
        const px = parseFloat(x);
        const py = parseFloat(y);
        const pz = parseFloat(z);
        if (Number.isFinite(px)) pl.x = Math.max(-MAX_POS, Math.min(MAX_POS, px));
        if (Number.isFinite(py)) pl.y = Math.max(-MAX_POS, Math.min(MAX_POS, py));
        if (Number.isFinite(pz)) pl.z = Math.max(-MAX_POS, Math.min(MAX_POS, pz));

        // Username approval
        let usernameRejected = null;
        if (typeof username === 'string' && username.trim()) {
            // Allow renaming even if already approved, but validate
            const r = isValidUsername(username);
            if (r.ok) {
                const trimmed = username.trim();
                if (!pl.approved || pl.username !== trimmed) {
                    pl.username = trimmed;
                    if (!pl.displayName) pl.displayName = trimmed;
                    pl.approved = true;
                    // Save to persistent store
                    nameStore[id] = { username: pl.username, displayName: pl.displayName || trimmed, ts: now };
                }
            } else if (!pl.approved) {
                usernameRejected = r.reason;
            }
        }

        // Profile updates - save immediately to persistent stores
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
            // Even if not yet approved, allow avatar save if we have it in store for later
            if (isValidAvatar(avatar)) {
                avatarStore[id] = { avatar: avatar, ts: now };
                pl.avatar = avatar;
            }
        }

        // Chat
        let chatBlocked = false;
        if (typeof chat === 'string' && chat.trim() && pl.approved) {
            const clean = chat.trim().slice(0, 140);
            if (clean) {
                if (isBad(clean)) {
                    chatBlocked = true;
                } else {
                    chatCounter++;
                    chatBuffer.push({
                        mid: chatCounter,
                        id,
                        username: pl.displayName || pl.username || 'Player',
                        avatar: pl.avatar || (avatarStore[id] ? avatarStore[id].avatar : null),
                        text: clean,
                        ts: Date.now()
                    });
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
                    x: pdata.x,
                    y: pdata.y,
                    z: pdata.z,
                    color: pdata.color,
                    playtime: pdata.playtime
                };
            }
        }

        const recentChat = chatBuffer.filter(m => m.ts > now - 10000 && m.id !== id).map(m => ({
            mid: m.mid,
            id: m.id,
            username: m.username,
            avatar: m.avatar,
            text: m.text,
            ts: m.ts
        }));

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            myPlaytime: pl.playtime,
            displayName: pl.displayName || (nameStore[id] ? nameStore[id].displayName : null),
            avatar: pl.avatar || (avatarStore[id] ? avatarStore[id].avatar : null),
            players: otherPlayers,
            chat: recentChat
        });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
}
