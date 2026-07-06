// /api/sync.js – Vercel Serverless – Multiplayer Sync for 3D Games
// Supports: username approval, position sync (x, y, z), chat
// In-memory only – resets on cold start

let players = {};
let chatBuffer = [];
const MAX_CHAT_BUFFER = 50;
const PLAYER_TIMEOUT = 20000;
const MAX_POS = 5000;

const BAD = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s) { return typeof s === 'string' && BAD.test(s.toLowerCase()); }

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
    // trim old chat messages
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

        let { id, username, name, x, y, z, chat } = p;

        // Client sends ?name= – map to username
        if (!username && name) username = decodeURIComponent(name);

        if (!id || typeof id !== 'string') {
            return res.status(200).json({ ok: false, error: 'Missing id' });
        }

        // Create or update player
        if (!players[id]) {
            players[id] = {
                x: 0,
                y: 0,
                z: 0,
                username: null,
                approved: false,
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                lastSeen: Date.now()
            };
        }

        const pl = players[id];
        pl.lastSeen = Date.now();

        // Position sync (x, y = horizontal, z = vertical height)
        const px = parseFloat(x);
        const py = parseFloat(y);
        const pz = parseFloat(z);

        if (Number.isFinite(px)) pl.x = Math.max(-MAX_POS, Math.min(MAX_POS, px));
        if (Number.isFinite(py)) pl.y = Math.max(-MAX_POS, Math.min(MAX_POS, py));
        if (Number.isFinite(pz)) pl.z = Math.max(-MAX_POS, Math.min(MAX_POS, pz));

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
                    if (chatBuffer.length > MAX_CHAT_BUFFER) chatBuffer.shift();
                }
            }
        }

        // Build other players list (exclude self)
        const otherPlayers = {};
        for (const [pid, pdata] of Object.entries(players)) {
            if (pid !== id && pdata.approved) {
                otherPlayers[pid] = {
                    username: pdata.username,
                    name: pdata.username,
                    x: pdata.x,
                    y: pdata.y,
                    z: pdata.z,
                    color: pdata.color
                };
            }
        }

        const now = Date.now();
        // Get recent chat messages (last 10 seconds, exclude own messages)
        const recentChat = chatBuffer.filter(m => m.ts > now - 10000 && m.id !== id);

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            players: otherPlayers,
            chat: recentChat
        });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
}
