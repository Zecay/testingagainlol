// api/sync.js — Simple 2D top-down multiplayer sync server
// Vercel Serverless Function (Node)
// 
// Client sends (GET):
//   ?id=<playerId>&name=<urlEncodedName>&x=<int>&y=<int>&hat=<id>&credits=<int>&_t=<cacheBuster>
// Server returns:
//   { "<playerId>": { x, y, name, hat, credits, playTimeMs, t }, ... }
//
// WARNING: In-memory only. Resets on cold start, and Vercel may run multiple instances.
// For production use Cloudflare Durable Objects.

let players = {};

const PLAYER_TIMEOUT = 5000; // Drop players we haven't heard from in 5s
const MAX_NAME_LEN = 25;
const MAX_PLAYERS = 200;

function sanitizeString(s, max = 32) {
  if (typeof s !== 'string') return '';
  return s.slice(0, max).replace(/[<>]/g, '');
}

export default function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // support GET ?query and POST JSON body
    const src = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;
    const { id, name, x, y, hat, credits, playTimeMs } = src || {};

    const now = Date.now();

    // --- UPDATE / REGISTER THIS PLAYER ---
    if (id && typeof id === 'string' && id.length <= 64) {
      const px = parseInt(x, 10);
      const py = parseInt(y, 10);

      if (!Number.isNaN(px) && !Number.isNaN(py)) {
        const prev = players[id] || {};

        // simple rate limiting / anti-teleport:
        // if (prev.x !== undefined) {
        //   const dist = Math.hypot(px - prev.x, py - prev.y);
        //   if (dist > 800) { /* reject */ }
        // }

        players[id] = {
          x: px,
          y: py,
          name: name
            ? sanitizeString(decodeURIComponent(name), MAX_NAME_LEN)
            : (prev.name || id.slice(0, 12)),
          hat: hat ? sanitizeString(hat, 32) : (prev.hat || 'character1'),
          credits: Number.isFinite(+credits) ? Math.max(0, Math.floor(+credits)) : (prev.credits || 0),
          playTimeMs: Number.isFinite(+playTimeMs) ? Math.max(0, Math.floor(+playTimeMs)) : (prev.playTimeMs || 0),
          t: now
        };

        // cap player count (FIFO evict oldest)
        const pids = Object.keys(players);
        if (pids.length > MAX_PLAYERS) {
          pids.sort((a,b) => players[a].t - players[b].t);
          for (let i = 0; i < pids.length - MAX_PLAYERS; i++) {
            delete players[pids[i]];
          }
        }
      }
    }

    // --- CLEAN UP STALE PLAYERS ---
    for (const pid in players) {
      if (now - players[pid].t > PLAYER_TIMEOUT) {
        delete players[pid];
      }
    }

    // --- BUILD RESPONSE (strip internal timestamp if you want, I leave t for client debugging) ---
    const out = {};
    for (const pid in players) {
      const p = players[pid];
      out[pid] = {
        x: p.x,
        y: p.y,
        name: p.name,
        hat: p.hat,
        credits: p.credits,
        playTimeMs: p.playTimeMs,
        // t: p.t  // uncomment if client needs it
      };
    }

    // Prevent any caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json(out);

  } catch (err) {
    res.status(500).json({ error: err.message || 'sync error' });
  }
}
