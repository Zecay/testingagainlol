// api/sync.js
let players = {};

export default function handler(req, res) {
  // --- CRITICAL CORS HEADERS ---
  // Allow requests from your specific Remix development playground
  res.setHeader('Access-Control-Allow-Origin', 'https://api.remix.gg');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle browser pre-flight checks (OPTIONS requests)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  // -----------------------------

  const { id, x, y } = req.query;
  
  if (id && x && y) {
    players[id] = { 
      x: parseInt(x), 
      y: parseInt(y), 
      t: Date.now() 
    };
  }

  // Active player cleanup (4 seconds)
  const now = Date.now();
  for (let pId in players) {
    if (now - players[pId].t > 4000) {
      delete players[pId];
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(players);
}
