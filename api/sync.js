// /api/sync.js – Vercel Serverless – port of Zecay/multiplayer-server POST /api/sync
// Compatible with Hangout Online / GridSphere polling client
// Supports: move, username approval, hat, credits, playTimeMs, ownedCharacters, chat, PM
// In-memory only – resets on cold start

let players = {};
let chatBuffer = [];
let pmBuffers = {}; // { playerId: [ {from, fromUsername, text, ts} ] }

const MAX_CHAT_BUFFER = 50;
const MAX_PM_BUFFER = 30;
const PLAYER_TIMEOUT = 15000;
const MAX_POS = 5000;

const ALLOWED_HATS = new Set([
  'character1','character2','character3','character4','character5',
  'character6','character7','character8','character9','character10', null
]);

// very light profanity – replace with bad-words if you bundle it
const BAD = /\b(nigga|fag|faggot|retard|kys|tranny|chink|spic)\b/i;
function isBad(s){ return typeof s==='string' && BAD.test(s.toLowerCase()); }

function isValidUsername(name){
  if(!name || !name.trim()) return {ok:false, reason:'Username cannot be empty.'};
  const n = name.trim();
  if(n.length>25) return {ok:false, reason:'Username is too long.'};
  if(!/^[a-zA-Z0-9_ ]+$/.test(n)) return {ok:false, reason:'Only letters, numbers, underscores and spaces allowed.'};
  if(isBad(n)) return {ok:false, reason:'That username is not allowed.'};
  return {ok:true};
}

function cleanup(){
  const now = Date.now();
  for(const id in players){
    if(now - players[id].lastSeen > PLAYER_TIMEOUT){
      delete players[id];
      delete pmBuffers[id];
    }
  }
  // trim chat
  const cutoff = now - 10000;
  while(chatBuffer.length && chatBuffer[0].ts < cutoff) chatBuffer.shift();
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if(req.method==='OPTIONS') return res.status(204).end();

  try{
    cleanup();

    // accept GET query or POST json
    const body = req.method==='POST' ? (req.body || {}) : {};
    const q = req.query || {};
    const p = {...q, ...body};

    let { id, username, name, x, y, hat, credits, playTimeMs, ownedCharacters, chat, pmTo, pmText } = p;
    // client sends ?name=  – map to username
    if(!username && name) username = decodeURIComponent(name);

    if(!id || typeof id!=='string') {
      // still return world state so client can see players even before registering
      return res.status(200).json({ ok:false, error:'Missing id' });
    }

    if(!players[id]){
      players[id] = {
        x:0, y:0, username:null, approved:false,
        color:'#4fc3f7', hat:null, credits:0, playTimeMs:0,
        ownedCharacters:['character1','character2'],
        lastSeen: Date.now()
      };
    }
    const pl = players[id];
    pl.lastSeen = Date.now();

    // position
    const px = parseFloat(x), py = parseFloat(y);
    if(Number.isFinite(px)) pl.x = Math.max(-MAX_POS, Math.min(MAX_POS, px));
    if(Number.isFinite(py)) pl.y = Math.max(-MAX_POS, Math.min(MAX_POS, py));

    // username approval
    let usernameRejected = null;
    if(typeof username==='string' && username.trim() && !pl.approved){
      const r = isValidUsername(username);
      if(r.ok){ pl.username = username.trim(); pl.approved = true; }
      else { usernameRejected = r.reason; }
    }

    // hat
    if(hat!==undefined && (hat===null || ALLOWED_HATS.has(hat))) pl.hat = hat;
    // credits / playtime / owned
    if(Number.isFinite(+credits)) pl.credits = Math.max(0, Math.floor(+credits));
    if(Number.isFinite(+playTimeMs)) pl.playTimeMs = Math.max(0, Math.floor(+playTimeMs));
    if(Array.isArray(ownedCharacters)){
      pl.ownedCharacters = [...new Set(ownedCharacters.filter(v=>typeof v==='string'&&v))].slice(0,20);
    } else if(typeof ownedCharacters==='string' && ownedCharacters){
      // support comma list ?owned=character1,character2
      pl.ownedCharacters = ownedCharacters.split(',').filter(Boolean).slice(0,20);
    }

    // chat
    let chatBlocked = false;
    if(typeof chat==='string' && chat.trim() && pl.approved){
      const clean = chat.trim().slice(0,140);
      if(clean){
        if(isBad(clean)){ chatBlocked = true; }
        else {
          chatBuffer.push({ id, username: pl.username||'Player', text: clean, ts: Date.now() });
          if(chatBuffer.length > MAX_CHAT_BUFFER) chatBuffer.shift();
        }
      }
    }

    // PM
    let pmError = null;
    if(pmTo && typeof pmText==='string' && pmText.trim() && pl.approved){
      const clean = pmText.trim().slice(0,300);
      const target = players[pmTo];
      if(!target || !target.approved){
        pmError = 'That player is no longer online.';
      } else {
        const msg = { from:id, fromUsername: pl.username||'Player', text:clean, ts:Date.now() };
        if(!pmBuffers[pmTo]) pmBuffers[pmTo]=[];
        pmBuffers[pmTo].push(msg);
        if(pmBuffers[pmTo].length > MAX_PM_BUFFER) pmBuffers[pmTo].shift();
        // echo to sender
        if(!pmBuffers[id]) pmBuffers[id]=[];
        pmBuffers[id].push({...msg, isSelf:true});
        if(pmBuffers[id].length > MAX_PM_BUFFER) pmBuffers[id].shift();
      }
    }

    // build otherPlayers
    const otherPlayers = {};
    for(const [pid, pdata] of Object.entries(players)){
      if(pid!==id && pdata.approved){
        otherPlayers[pid] = {
          username: pdata.username,
          name: pdata.username, // compat
          x: pdata.x, y: pdata.y,
          hat: pdata.hat,
          color: pdata.color,
          credits: pdata.credits,
          playTimeMs: pdata.playTimeMs,
          ownedCharacters: pdata.ownedCharacters
        };
      }
    }

    const now = Date.now();
    const recentChat = chatBuffer.filter(m => m.ts > now-3000 && m.id !== id);
    const myPMs = pmBuffers[id] ? pmBuffers[id].splice(0) : [];
    if(pmBuffers[id] && !pmBuffers[id].length) delete pmBuffers[id];

    res.status(200).json({
      ok: true,
      myId: id,
      usernameApproved: !!pl.approved,
      usernameRejected,
      chatBlocked,
      pmError,
      players: otherPlayers,
      chat: recentChat,
      pms: myPMs
    });

  }catch(err){
    res.status(500).json({ ok:false, error: err.message });
  }
}
