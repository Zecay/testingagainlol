// /api/sync.js – Vercel Serverless Function
// Multiplayer sync: position, chat, username, profile, playtime
// In-memory only (resets on cold start)

let players = {};
let chatBuffer = [];
const MAX_CHAT = 50;
const PLAYER_TIMEOUT = 30000;
const MAX_POS = 5000;

const BAD_WORDS = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) {
    return typeof s === 'string' && BAD_WORDS.test(s.toLowerCase());
}

function isValidUsername(name) {
    if (!name || !name.trim()) return { ok: false, reason: 'Username cannot be empty.' };
    const n = name.trim();
    if (n.length > 25) return { ok: false, reason: 'Username is too long.' };
    if (!/^[a-zA-Z0-9_ ]+$/.test(n)) return { ok: false, reason: 'Only letters, numbers, underscores and spaces allowed.' };
    if (isBad(n)) return { ok: false, reason: 'That username is not allowed.' };
    return { ok: true };
}

function cleanup() {
    const now = Date.now();
    for (const id in players) {
        if (now - players[id].lastSeen > PLAYER_TIMEOUT) {
            delete players[id];
        }
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

        if (!username && name) username = decodeURIComponent(name);

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

        // Username approval (first time only via query params)
        let usernameRejected = null;
        if (typeof username === 'string' && username.trim() && !pl.approved) {
            const r = isValidUsername(username);
            if (r.ok) {
                pl.username = username.trim();
                if (!pl.displayName) pl.displayName = pl.username;
                pl.approved = true;
            } else {
                usernameRejected = r.reason;
            }
        }

        // Profile updates (POST body for approved players)
        if (pl.approved) {
            if (typeof displayName === 'string' && displayName.trim()) {
                const r = isValidUsername(displayName);
                if (r.ok) {
                    pl.displayName = displayName.trim();
                }
            }
            if (typeof avatar === 'string' && avatar.startsWith('data:image/') && avatar.length < 200000) {
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
                    chatBuffer.push({
                        id,
                        username: pl.displayName || pl.username || 'Player',
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
                    avatar: pdata.avatar,
                    x: pdata.x,
                    y: pdata.y,
                    z: pdata.z,
                    color: pdata.color,
                    playtime: pdata.playtime
                };
            }
        }

        const recentChat = chatBuffer.filter(m => m.ts > now - 10000 && m.id !== id);

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            myPlaytime: pl.playtime,
            displayName: pl.displayName,
            avatar: pl.avatar,
            players: otherPlayers,
            chat: recentChat
        });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
}
