// /api/cleanup.js - Vercel Cron job to auto-delete old data
// Keeps DB under 1.5GB by removing old chats, kicks, expired bans
// Vercel will call this every 10 min via vercel.json crons
// Also called manually via GET https://your-domain.vercel.app/api/cleanup?secret=xxx (optional secret check)

import { getSupabaseClient } from './_lib/supabase.js';

const CHAT_RETENTION_MS = 90 * 60 * 1000; // 90 minutes
const KICK_RETENTION_MS = 15 * 60 * 1000; // 15 minutes

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    // Optional simple secret protection: ?secret=YOUR_SECRET or via env CLEANUP_SECRET
    const secret = process.env.CLEANUP_SECRET;
    if (secret) {
        const provided = req.query?.secret || req.headers['x-cleanup-secret'];
        if (provided !== secret) {
            // Allow Vercel cron (no secret) but block random public calls if secret set
            // Vercel cron sends no secret, so we allow if user-agent is vercel-cron
            const ua = req.headers['user-agent'] || '';
            if (!ua.toLowerCase().includes('vercel-cron')) {
                // For now, don't hard block - just log
                console.warn('Cleanup called without secret, UA:', ua);
            }
        }
    }

    try {
        const client = getSupabaseClient();
        const now = Date.now();
        const chatCutoff = now - CHAT_RETENTION_MS;
        const kickCutoff = now - KICK_RETENTION_MS;

        // Delete old chats
        const { error: chatError, count: chatCount } = await client
            .from('chats')
            .delete()
            .lt('ts', chatCutoff);

        // Delete old kicks
        const { error: kickError, count: kickCount } = await client
            .from('kicks')
            .delete()
            .lt('kicked_at', kickCutoff);

        // Delete expired bans (only where expires_at is set and past)
        const { error: banError, count: banCount } = await client
            .from('bans')
            .delete()
            .not('expires_at', 'is', null)
            .lt('expires_at', now);

        // Also cleanup old users? Optional - delete users never logged in for 90 days except admins
        // Uncomment if you want:
        // const ninetyDaysAgo = now - 90*24*60*60*1000;
        // await client.from('users').delete().lt('last_login', ninetyDaysAgo).eq('is_admin', false);

        return res.status(200).json({
            ok: true,
            message: 'Cleanup done',
            deleted: {
                chats_older_than_90min: chatError ? `error: ${chatError.message}` : 'ok',
                kicks_older_than_15min: kickError ? `error: ${kickError.message}` : 'ok',
                expired_bans: banError ? `error: ${banError.message}` : 'ok'
            },
            cutoff: {
                chatCutoff: new Date(chatCutoff).toISOString(),
                kickCutoff: new Date(kickCutoff).toISOString()
            }
        });

    } catch (err) {
        console.error('cleanup error', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
