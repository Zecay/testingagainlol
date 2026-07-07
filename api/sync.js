// /api/sync.js – Vercel Serverless Function
// Multiplayer sync: position, chat, username, playtime, profile

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

        let { id, username, name, x, y, z, chat, playtime, avatarColor, profileUpdate, newUsername, newAvatarColor } = p;

        if (!username && name) username = decodeURIComponent(name);

        if (!id || typeof id !== 'string') {
            return res.status(200).json({ ok: false, error: 'Missing id' });
        }

        if (!players[id]) {
            players[id] = {
                x: 0, y: 0, z: 0,
                username: null,
                approved: false,
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                avatarColor: '#3498db',
                playtime: 0,
                lastSeen: Date.now()
            };
        }

        const pl = players[id];
        pl.lastSeen = Date.now();

        // Position sync
        const px = parseFloat(x);
        const py = parseFloat(y);
        const pz = parseFloat(z);
        if (Number.isFinite(px)) pl.x = Math.max(-MAX_POS, Math.min(MAX_POS, px));
        if (Number.isFinite(py)) pl.y = Math.max(-MAX_POS, Math.min(MAX_POS, py));
        if (Number.isFinite(pz)) pl.z = Math.max(-MAX_POS, Math.min(MAX_POS, pz));

        // Playtime sync
        const pt = parseInt(playtime);
        if (Number.isFinite(pt) && pt >= 0) pl.playtime = pt;

        // Avatar color sync
        if (typeof avatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(avatarColor)) {
            pl.avatarColor = avatarColor;
        }

        // Username approval
        let usernameRejected = null;
        if (typeof username === 'string' && username.trim() && !pl.approved) {
            const r = isValidUsername(username);
            if (r.ok) {
                pl.username = username.trim();
                pl.approved = true;
            } else {
                usernameRejected = r.reason;
            }
        }

        // Profile update (name/avatar change after initial join)
        let profileUpdateResult = null;
        if (profileUpdate === '1' && pl.approved) {
            if (typeof newUsername === 'string' && newUsername.trim()) {
                const r = isValidUsername(newUsername);
                if (r.ok) {
                    pl.username = newUsername.trim();
                    profileUpdateResult = { ok: true, newUsername: pl.username };
                } else {
                    profileUpdateResult = { ok: false, error: r.reason };
                }
            }
            if (typeof newAvatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(newAvatarColor)) {
                pl.avatarColor = newAvatarColor;
                if (!profileUpdateResult) profileUpdateResult = { ok: true };
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
                    name: pdata.username,
                    x: pdata.x,
                    y: pdata.y,
                    z: pdata.z,
                    color: pdata.color,
                    avatarColor: pdata.avatarColor,
                    playtime: pdata.playtime
                };
            }
        }

        const now = Date.now();
        const recentChat = chatBuffer.filter(m => m.ts > now - 10000 && m.id !== id);

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            players: otherPlayers,
            chat: recentChat,
            myPlaytime: pl.playtime,
            profileUpdate: profileUpdateResult
        });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
}
