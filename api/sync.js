// api/sync.js
let players = {};

export default function handler(req, res) {
  const { id, x, y } = req.query;
  
  if (id && x && y) {
    players[id] = { x: parseInt(x), y: parseInt(y), t: Date.now() };
  }

  // Cleanup: Remove inactive players (> 5s)
  const now = Date.now();
  for (let p in players) {
    if (now - players[p].t > 5000) delete players[p];
  }

  res.status(200).json(players);
}
