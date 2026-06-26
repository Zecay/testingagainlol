// api/sync.js — Growtopia-style Sandbox MMO Server
// Single endpoint handling player sync, worlds, blocks, and chat

// --- IN-MEMORY STATE (resets when function goes cold) ---
// worlds: { [worldName]: { players: {}, blocks: {}, chat: [] } }
let worlds = {};
const BLOCK_TYPES = [
  { id: 0, name: 'Air', color: '#1a1a2e', solid: false },
  { id: 1, name: 'Grass', color: '#4a7c59', solid: true },
  { id: 2, name: 'Dirt', color: '#8B5E3C', solid: true },
  { id: 3, name: 'Stone', color: '#6B6B6B', solid: true },
  { id: 4, name: 'Wood', color: '#8B6B3C', solid: true },
  { id: 5, name: 'Brick', color: '#B85C3C', solid: true },
  { id: 6, name: 'Glass', color: '#88CCEE', solid: true },
  { id: 7, name: 'Gold', color: '#FFD700', solid: true },
  { id: 8, name: 'Lava', color: '#FF4400', solid: false },
];

const CHAT_MAX = 50;
const PLAYER_TIMEOUT = 5000;
const WORLD_WIDTH = 100;
const WORLD_HEIGHT = 100;
const DEFAULT_BLOCK = 1; // Grass

function generateWorld(name) {
  const blocks = {};
  // Fill with grass at ground level (y = 30-40 range)
  for (let x = 0; x < WORLD_WIDTH; x++) {
    for (let y = 30; y < 40; y++) {
      blocks[`${x},${y}`] = 1; // Grass
    }
    // A few dirt layers below
    for (let y = 40; y < 45; y++) {
      blocks[`${x},${y}`] = 2; // Dirt
    }
    // Stone layer
    for (let y = 45; y < 50; y++) {
      blocks[`${x},${y}`] = 3; // Stone
    }
  }
  return blocks;
}

export default function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { action, world, id, x, y, name, blockX, blockY, blockType, message } = req.query;

  // Ensure world exists
  if (world) {
    if (!worlds[world]) {
      worlds[world] = {
        players: {},
        blocks: generateWorld(world),
        chat: []
      };
    }
  }

  // Cleanup stale players in all worlds
  const now = Date.now();
  for (const wName in worlds) {
    const w = worlds[wName];
    for (const pId in w.players) {
      if (now - w.players[pId].t > PLAYER_TIMEOUT) {
        delete w.players[pId];
      }
    }
    // Clean up empty worlds
    if (Object.keys(w.players).length === 0) {
      // Keep world for a bit even if empty, but delete after 30s of no players
      if (!w.emptySince) w.emptySince = now;
      if (now - w.emptySince > 30000) {
        delete worlds[wName];
      }
    } else {
      if (w.emptySince) delete w.emptySince;
    }
  }

  try {
    switch (action) {
      // --- PLAYER SYNC ---
      case 'sync': {
        if (!world || !id) {
          res.status(400).json({ error: 'Missing world or id' });
          return;
        }
        const w = worlds[world];
        if (x !== undefined && y !== undefined) {
          w.players[id] = {
            x: parseInt(x),
            y: parseInt(y),
            name: name ? decodeURIComponent(name) : id,
            t: now
          };
        }
        // Return all players in this world
        const playerList = {};
        for (const pId in w.players) {
          playerList[pId] = { ...w.players[pId] };
          delete playerList[pId].t;
        }
        res.status(200).json({
          players: playerList,
          chat: w.chat.slice(-CHAT_MAX)
        });
        return;
      }

      // --- WORLD LISTING ---
      case 'listWorlds': {
        const list = [];
        for (const wName in worlds) {
          const w = worlds[wName];
          list.push({
            name: wName,
            playerCount: Object.keys(w.players).length,
            blockCount: Object.keys(w.blocks).filter(k => w.blocks[k] !== 0).length
          });
        }
        res.status(200).json({ worlds: list });
        return;
      }

      // --- CREATE WORLD ---
      case 'createWorld': {
        const wName = world;
        if (!wName) {
          res.status(400).json({ error: 'World name required' });
          return;
        }
        if (wName.length > 15) {
          res.status(400).json({ error: 'World name too long (max 15)' });
          return;
        }
        if (worlds[wName]) {
          res.status(200).json({ success: true, exists: true });
          return;
        }
        worlds[wName] = {
          players: {},
          blocks: generateWorld(wName),
          chat: []
        };
        res.status(200).json({ success: true, exists: false });
        return;
      }

      // --- GET BLOCKS FOR A WORLD ---
      case 'getBlocks': {
        if (!world || !worlds[world]) {
          res.status(200).json({ blocks: {} });
          return;
        }
        // Return only blocks that aren't air (0)
        const w = worlds[world];
        const solidBlocks = {};
        for (const key in w.blocks) {
          if (w.blocks[key] !== 0) {
            solidBlocks[key] = w.blocks[key];
          }
        }
        res.status(200).json({ blocks: solidBlocks });
        return;
      }

      // --- PLACE / BREAK BLOCK ---
      case 'setBlock': {
        if (!world || !worlds[world]) {
          res.status(400).json({ error: 'World not found' });
          return;
        }
        const bx = parseInt(blockX);
        const by = parseInt(blockY);
        const bt = parseInt(blockType);
        
        if (isNaN(bx) || isNaN(by) || isNaN(bt)) {
          res.status(400).json({ error: 'Invalid block coordinates or type' });
          return;
        }
        
        const w = worlds[world];
        const key = `${bx},${by}`;
        
        if (bt === 0) {
          // Break block (set to air)
          delete w.blocks[key];
        } else {
          // Place block
          w.blocks[key] = bt;
        }
        
        // Broadcast to chat
        const playerName = name ? decodeURIComponent(name) : id;
        const action = bt === 0 ? 'broke' : 'placed';
        const blockName = bt === 0 ? 'a block' : BLOCK_TYPES.find(b => b.id === bt)?.name || 'block';
        w.chat.push({
          text: `${playerName} ${action} ${blockName}`,
          time: Date.now()
        });
        if (w.chat.length > CHAT_MAX) w.chat.shift();
        
        res.status(200).json({ success: true });
        return;
      }

      // --- SEND CHAT ---
      case 'sendChat': {
        if (!world || !worlds[world]) {
          res.status(400).json({ error: 'World not found' });
          return;
        }
        if (!message || !message.trim()) {
          res.status(200).json({ success: true });
          return;
        }
        const playerName = name ? decodeURIComponent(name) : id;
        const w = worlds[world];
        w.chat.push({
          text: `${playerName}: ${message.trim().slice(0, 200)}`,
          time: Date.now(),
          sender: id
        });
        if (w.chat.length > CHAT_MAX) w.chat.shift();
        res.status(200).json({ success: true });
        return;
      }

      default:
        res.status(200).json({ 
          status: 'Growtopia-like Sandbox MMO',
          worlds: Object.keys(worlds).length,
          actions: ['sync', 'listWorlds', 'createWorld', 'getBlocks', 'setBlock', 'sendChat']
        });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
