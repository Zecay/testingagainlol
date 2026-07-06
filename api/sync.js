// /api/sync.js – Vercel Serverless Function
// Multiplayer sync: position, chat, username, build system
// In-memory only (resets on cold start)

let players = {};
let chatBuffer = [];
let buildActions = [];       // { v, action, id, x,y,z, sx,sy,sz, rx,ry,rz, color, owner }
let buildVersion = 0;
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
    // Trim old chat (keep last 15s)
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

        let { id, username, name, x, y, z, chat, build } = p;

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
                    if (chatBuffer.length > MAX_CHAT) chatBuffer.shift();
                }
            }
        }

        // Build system - process build actions from clients
        if (typeof build === 'string' && pl.approved) {
            try {
                const bData = JSON.parse(build);
                if (bData.action && bData.id) {
                    buildVersion++;
                    const record = { v: buildVersion, action: bData.action, id: bData.id };

                    if (bData.action === 'add') {
                        record.x = bData.x || 0;
                        record.y = bData.y || 1;
                        record.z = bData.z || 0;
                        record.sx = bData.sx || 2;
                        record.sy = bData.sy || 2;
                        record.sz = bData.sz || 2;
                        record.rx = bData.rx || 0;
                        record.ry = bData.ry || 0;
                        record.rz = bData.rz || 0;
                        record.color = bData.color || 0x4CAF50;
                        record.owner = id;
                    } else if (bData.action === 'update') {
                        record.x = bData.x; record.y = bData.y; record.z = bData.z;
                        record.sx = bData.sx; record.sy = bData.sy; record.sz = bData.sz;
                        record.rx = bData.rx; record.ry = bData.ry; record.rz = bData.rz;
                        record.color = bData.color;
                    }
                    // For delete, just need the id

                    buildActions.push(record);

                    // Keep only last 500 build actions
                    if (buildActions.length > 500) {
                        buildActions = buildActions.slice(-500);
                    }
                }
            } catch (e) { /* ignore bad build payload */ }
        }

        // Build response: send all build actions since client's last version
        const clientBuildV = parseInt(p.buildV) || 0;
        const newBuilds = buildActions.filter(b => b.v > clientBuildV);

        // Other players list
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
        const recentChat = chatBuffer.filter(m => m.ts > now - 10000 && m.id !== id);

        res.status(200).json({
            ok: true,
            myId: id,
            usernameApproved: !!pl.approved,
            usernameRejected,
            chatBlocked,
            players: otherPlayers,
            chat: recentChat,
            builds: newBuilds,
            buildV: buildVersion
        });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
}
