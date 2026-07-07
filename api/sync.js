// /api/sync.js – Vercel Serverless Function
// Multiplayer sync: position, chat, username, avatar, playtime
// In-memory only (resets on cold start)

let players = {};
let chatBuffer = [];
const MAX_CHAT = 50;
const PLAYER_TIMEOUT = 7 * 24 * 60 * 60 * 1000; // 7 days – persist playtime between sessions
const MAX_POS = 5000;

const BAD_WORDS = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) {
    return typeof s === 'string' && BAD_WORDS.test(s.toLowerCase());
}

function isValidUsername(name) {
    if (!name || !name.trim()) return { ok: false, reason: 'Username cannot be empty.' };
    const n = name.trim();
    if (n.length > 25) return { ok: false, reason: 'Username is too long.' };
    if (n.length < 2) return { ok: false, reason: 'Username too short.' };
    if (!/^[a-zA-Z0-9_ ]+$/.test(n)) return { ok: false, reason: 'Only letters, numbers, underscores and spaces allowed.' };
    if (isBad(n)) return { ok: false, reason: 'That username is not allowed.' };
    return { ok: true };
}

function isValidAvatar(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.trim();
    if (!u) return true; // allow empty to clear
    if (u.length > 500) return false;
    // allow http/https, data:image, and roblox-like asset ids
    return /^(https?:\/\/|data:image\/|\/\/)/i.test(u) || u.startsWith('/') || /^[a-zA-Z0-9_\-./:]+$/.test(u);
}

function cleanup() {
    const now = Date.now();
    for (const id in players) {
        if (now - players[id].lastSeen > PLAYER_TIMEOUT) {
            delete players[id];
        }
    }
    const cutoff = now - 30000;
    while (chatBuffer.length && chatBuffer[0].ts < cutoff) chatBuffer.shift();
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        cleanup();

        const body = req.method === 'POST' ? (req.body || {}) : {};
        const q = req.query || {};
        const p = { ...q, ...body };

        let { id, username, name, x, y, z, chat, avatar, playtime } = p;

        if (!username && name) username = decodeURIComponent(name);

        if (!id || typeof id !== 'string') {
            return res.status(200).json({ ok: false, error: 'Missing id' });
        }

        const now = Date.now();

        if (!players[id]) {
            players[id] = {
                x: 0, y: 0, z: 0,
                username: null,
                approved: false,
                avatar: '',
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                totalPlaytime: 0,
                lastSeen: now,
                joinTime: now
            };
        }

        const pl = players[id];

        // Playtime accounting – server authoritative
        if (pl.lastSeen && now > pl.lastSeen) {
            const deltaSec = (now - pl.lastSeen) / 1000;
            // cap delta to avoid huge jumps on reconnect after long absence
            if (deltaSec < 120) {
                pl.totalPlaytime += deltaSec;
            }
        }
        pl.lastSeen = now;

        // Client-reported playtime (use max to help persist across devices)
        const clientPt = parseFloat(playtime);
        if (Number.isFinite(clientPt) && clientPt > pl.totalPlaytime) {
            // allow client to restore higher saved time, capped reasonably
            pl.totalPlaytime = Math.min(clientPt, pl.totalPlaytime + 3600);
        }

        // Position sync
        const px = parseFloat(x);
        const py = parseFloat(y);
        const pz = parseFloat(z);
        if (Number.isFinite(px)) pl.x = Math.max(-MAX_POS, Math.min(MAX_POS, px));
        if (Number.isFinite(py)) pl.y = Math.max(-MAX_POS, Math.min(MAX_POS, py));
        if (Number.isFinite(pz)) pl.z = Math.max(-MAX_POS, Math.min(MAX_POS, pz));

        // Username update – allow changes after approved
        let usernameRejected = null;
        let usernameUpdated = false;
        if (typeof username === 'string' && username.trim()) {
            const cleanName = username.trim();
            if (cleanName !== pl.username) {
                const r = isValidUsername(cleanName);
                if (r.ok) {
                    pl.username = cleanName;
                    pl.approved = true;
                    usernameUpdated = true;
                } else {
                    usernameRejected = r.reason;
                }
            } else if (!pl.approved) {
                // re-approve existing
                pl.approved = true;
            }
        }

        // Avatar update
        let avatarRejected = null;
        if (typeof avatar === 'string') {
            const cleanAv = avatar.trim().slice(0, 500);
            if (cleanAv !== pl.avatar) {
                if (isValidAvatar(cleanAv) && !isBad(cleanAv)) {
                    pl.avatar = cleanAv;
                } else {
                    avatarRejected = 'Invalid avatar URL';
                }
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
                    chatBuffer.push({
                        id,
                        username: pl.username || 'Player',
                        avatar: pl.avatar || '',
                        text: clean,
                        ts: now
                    });
                    if (chatBuffer.length > MAX_CHAT) chatBuffer.shift();
                }
            }
        }

        const otherPlayers = {};
        for (const [pid, pdata] of Object.entries(players)) {
            if (pid !== id && pdata.approved && (now - pdata.lastSeen) < 60000) {
                otherPlayers[pid] = {
                    username: pdata.username,
                    name: pdata.username,
                    x: pdata.x,
                    y: pdata.y,
                    z: pdata.z,
                    color: pdata.color,
                    avatar: pdata.avatar || '',
                    playtime: Math.floor(pdata.totalPlaytime || 0)
                };
            }
        }

        // sort leaderboard server-side for convenience (client will re-sort)
        const leaderboard = Object.entries(players)
            .filter(([pid, pd]) => pd.approved && (now - pd.lastSeen) < 60000)
            .map(([pid, pd]) => ({
                id: pid,
                username: pd.username,
                avatar: pd.avatar || '',
                playtime: Math.floor(pd.totalPlaytime || 0),
                color: pd.color
            }))
            .sort((a, b) => b.playtime - a.playtime);

        const recentChat = chatBuffer.filter(m => m.ts > now - 30000 && m.id !== id);

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            avatarRejected,
            usernameUpdated,
            chatBlocked,
            players: otherPlayers,
            chat: recentChat,
            leaderboard,
            myProfile: {
                username: pl.username,
                avatar: pl.avatar || '',
                playtime: Math.floor(pl.totalPlaytime || 0),
                color: pl.color
            }
        });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
}
