// api/_lib/users.js - User storage handling
// Stores usernames and password hashes securely inside api/ folder
// Tries file persistence: api/users.json + /tmp/users.json + memory fallback

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to try (in order of preference for reading)
const PRIMARY_PATH = path.join(__dirname, '..', 'users.json'); // /api/users.json
const TMP_PATH = path.join('/tmp', 'brokheaven_users.json'); // Vercel writable
const FALLBACK_PATH = path.join(__dirname, 'users.json'); // api/_lib/users.json fallback

let memoryCache = null; // { lowerUsername: { username, passwordHash, avatar, createdAt, lastLogin } }
let lastLoadTime = 0;

function readJsonSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (e) {
        console.warn(`Failed to read ${filePath}:`, e.message);
    }
    return null;
}

function writeJsonSafe(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.warn(`Failed to write ${filePath}:`, e.message);
        return false;
    }
}

export function loadUsers() {
    // Cache for 2 seconds to avoid hammering FS
    if (memoryCache && Date.now() - lastLoadTime < 2000) return memoryCache;

    // Try TMP first (most recent on Vercel)
    let data = readJsonSafe(TMP_PATH);
    if (data) {
        memoryCache = data;
        lastLoadTime = Date.now();
        return data;
    }
    // Then primary
    data = readJsonSafe(PRIMARY_PATH);
    if (data) {
        memoryCache = data;
        lastLoadTime = Date.now();
        // Also sync to TMP
        writeJsonSafe(TMP_PATH, data);
        return data;
    }
    // Fallback path
    data = readJsonSafe(FALLBACK_PATH);
    if (data) {
        memoryCache = data;
        lastLoadTime = Date.now();
        return data;
    }
    // If nothing, use memoryCache or empty
    if (memoryCache) return memoryCache;
    memoryCache = {};
    lastLoadTime = Date.now();
    return memoryCache;
}

export function saveUsers(usersObj) {
    memoryCache = usersObj;
    lastLoadTime = Date.now();
    // Try to save to both TMP and primary (best effort)
    writeJsonSafe(TMP_PATH, usersObj);
    writeJsonSafe(PRIMARY_PATH, usersObj);
    writeJsonSafe(FALLBACK_PATH, usersObj);
}

export function findUser(users, username) {
    if (!username) return null;
    const lower = username.trim().toLowerCase();
    return users[lower] || null;
}

export function createUserRecord(username, passwordHash, avatar = null) {
    const now = Date.now();
    return {
        username: username.trim(), // preserve original case
        usernameLower: username.trim().toLowerCase(),
        passwordHash,
        avatar: avatar || null,
        createdAt: now,
        lastLogin: now,
        loginCount: 1
    };
}

export function sanitizeUserForClient(user) {
    // Never return passwordHash
    if (!user) return null;
    return {
        username: user.username,
        displayName: user.username,
        avatar: user.avatar || null,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
    };
}
