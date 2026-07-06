// api/sync.js — Simple 2D top-down multiplayer sync server
// Single endpoint: tracks player positions in one shared arena.
//
// Client sends (GET):  ?id=<playerId>&name=<urlEncodedName>&x=<int>&y=<int>&_t=<cacheBuster>
// Server returns:      { "<playerId>": { x, y, name }, ... }

// --- IN-MEMORY STATE (resets when the serverless function goes cold) ---
// players: { [playerId]: { x, y, name, t } }
let players = {};

const PLAYER_TIMEOUT = 5000; // Drop players we haven't heard from in 5s

export default function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { id, name, x, y } = req.query;
    const now = Date.now();

    // --- UPDATE / REGISTER THIS PLAYER ---
    if (id) {
      const px = parseInt(x, 10);
      const py = parseInt(y, 10);

      if (!Number.isNaN(px) && !Number.isNaN(py)) {
        const prev = players[id];
        players[id] = {
          x: px,
          y: py,
          // Keep previously stored name if this ping didn't include one
          name: name
            ? decodeURIComponent(name).slice(0, 15)
            : (prev ? prev.name : id),
          t: now
        };
      }
    }

    // --- CLEAN UP STALE PLAYERS ---
    for (const pid in players) {
      if (now - players[pid].t > PLAYER_TIMEOUT) {
        delete players[pid];
      }
    }

    // --- BUILD RESPONSE (strip internal timestamp) ---
    const out = {};
    for (const pid in players) {
      out[pid] = {
        x: players[pid].x,
        y: players[pid].y,
        name: players[pid].name
      };
    }

    // Prevent any caching of the response
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
