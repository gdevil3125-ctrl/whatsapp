const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
const REPLIES_FILE = path.join(DATA_DIR, 'replies.json');
const AI_SETTINGS_FILE = path.join(DATA_DIR, 'ai_settings.json');
const CONVERSATION_FILE = path.join(DATA_DIR, 'conversations.json');
const BUSINESS_CONTACTS_FILE = path.join(DATA_DIR, 'business_contacts.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load persisted data with error handling
function loadData(filepath, defaultValue = []) {
    try {
        if (fs.existsSync(filepath)) {
            const data = fs.readFileSync(filepath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`⚠️ Error loading ${filepath}:`, error.message);
    }
    return defaultValue;
}

// Save data to file with atomic write
function saveData(filepath, data) {
    try {
        const tempFile = filepath + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
        fs.renameSync(tempFile, filepath);
        return true;
    } catch (error) {
        console.error(`❌ Error saving ${filepath}:`, error.message);
        return false;
    }
}

// Data storage with persistence
let scheduledMessages = loadData(SCHEDULED_FILE, []);
let autoReplies = loadData(REPLIES_FILE, []);
let aiSettings = loadData(AI_SETTINGS_FILE, { enabled: false, apiKey: '', emergencyNumber: '', userName: '' });
let conversationHistory = loadData(CONVERSATION_FILE, {});
let businessContacts = loadData(BUSINESS_CONTACTS_FILE, {});
let qrCodeData = null;
let whatsappReady = false;
let isInitializing = false;

// Initialize WhatsApp Client with enhanced stability
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth'),
        clientId: 'whatsapp-automation-v1'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        timeout: 90000
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

// QR Code generation
client.on('qr', async (qr) => {
    console.log('📱 QR Code received, scan with WhatsApp app');
    try {
        qrCodeData = await qrcode.toDataURL(qr);
    } catch (error) {
        console.error('❌ QR Code generation error:', error.message);
    }
});

// WhatsApp ready
client.on('ready', () => {
    console.log('✅ WhatsApp Client is ready!');
    whatsappReady = true;
    isInitializing = false;
    qrCodeData = null;
});

// WhatsApp authenticated
client.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated successfully');
});

// Authentication failure
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
    whatsappReady = false;
    isInitializing = false;
    
    // Clear auth data and require re-scan
    setTimeout(() => {
        console.log('🔄 Please scan QR code again at /qr');
    }, 2000);
});

// Loading screen
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

// Handle incoming messages - UPDATED TO SKIP GROUPS AND BUSINESSES
client.on('message', async (message) => {
    if (!message.fromMe && whatsappReady) {
        // NEW: Check if message is from a group
        const chat = await message.getChat();
        if (chat.isGroup) {
            console.log(`🚫 Skipping group message from: ${chat.name}`);
            return; // Don't respond to group messages
        }
        
        const incomingText = message.body.trim();
        const contact = message.from;
        
        // NEW: Enhanced business detection - check contact info first
        try {
            const chatContact = await message.getContact();
            if (chatContact.isBusiness || chatContact.isEnterprise) {
                console.log(`🚫 Skipping business account: ${contact}`);
                return; // Don't respond to business accounts
            }
        } catch (error) {
            console.error('Error checking contact info:', error.message);
        }
        
        // Initialize business tracking if not exists
        if (!businessContacts[contact]) {
            businessContacts[contact] = {
                isBusiness: false,
                isVerified: false,
                responseCount: 0,
                detectionConfidence: 0
            };
        }
        
        const businessInfo = businessContacts[contact];
        
        // Advanced business pattern detection
        const businessPatterns = {
            automated: /\b(do not reply|automated|no-reply|noreply|this is an automated|bot)\b/i,
            transactional: /\b(order|#\d+|invoice|receipt|tracking|OTP|verification code|\d{4,6}|transaction|payment)\b/i,
            delivery: /\b(delivered|out for delivery|dispatched|courier|shipment|parcel)\b/i,
            notifications: /\b(booking confirmed|appointment|reminder|alert|notification)\b/i,
            marketing: /\b(offer|discount|sale|promo|coupon|limited time|shop now)\b/i
        };
        
        let detectionScore = 0;
        for (const [type, pattern] of Object.entries(businessPatterns)) {
            if (pattern.test(incomingText)) {
                detectionScore += 20;
                console.log(`🔍 Business pattern detected: ${type}`);
            }
        }
        
        // URL detection (common in business messages)
        if (/https?:\/\//.test(incomingText)) {
            detectionScore += 15;
        }
        
        // Short numeric codes (OTP, order IDs)
        if (/^\d{4,8}$/.test(incomingText.trim())) {
            detectionScore += 25;
        }
        
        // Update business status
        if (detectionScore >= 20) {
            businessInfo.isBusiness = true;
            businessInfo.detectionConfidence = Math.min(100, businessInfo.detectionConfidence + detectionScore);
            saveData(BUSINESS_CONTACTS_FILE, businessContacts);
        }
        
        // NEW: If detected as business, don't respond at all
        if (businessInfo.isBusiness) {
            console.log(`🚫 Skipping business message from ${contact} (Confidence: ${businessInfo.detectionConfidence}%)`);
            return; // Don't respond to business messages
        }
        
        // Check keyword-based auto-reply rules first
        const incomingLower = incomingText.toLowerCase();
        for (const rule of autoReplies) {
            if (incomingLower.includes(rule.trigger.toLowerCase())) {
                await message.reply(rule.response);
                console.log(`💬 Auto-replied to: ${contact}`);
                return;
            }
        }
        
        // If AI is enabled, use intelligent responses (only for non-business contacts)
        if (aiSettings.enabled && aiSettings.apiKey) {
            try {
                const aiResponse = await generateAIResponse(contact, incomingText, message);
                if (aiResponse) {
                    await message.reply(aiResponse);
                    console.log(`🤖 AI replied to: ${contact}`);
                    
                    // Save conversation history and business contacts
                    saveData(CONVERSATION_FILE, conversationHistory);
                    saveData(BUSINESS_CONTACTS_FILE, businessContacts);
                }
            } catch (error) {
                console.error('❌ AI response error:', error.message);
            }
        }
    }
});

// Handle disconnection with better recovery
client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp disconnected:', reason);
    whatsappReady = false;
    
    // Don't auto-reconnect on logout - require QR scan
    if (reason === 'LOGOUT') {
        console.log('🔑 Logged out. Please scan QR code again.');
        qrCodeData = null;
    } else if (!isInitializing) {
        console.log('🔄 Attempting to reconnect...');
        isInitializing = true;
        setTimeout(() => {
            client.initialize().catch(err => {
                console.error('❌ Reconnection failed:', err.message);
                isInitializing = false;
            });
        }, 5000);
    }
});

// Connection state monitoring
client.on('change_state', state => {
    console.log('🔄 Connection state changed:', state);
    if (state === 'CONFLICT' || state === 'UNPAIRED') {
        whatsappReady = false;
        console.log('⚠️ Connection conflict detected. Please check WhatsApp app.');
    }
});

// Initialize WhatsApp client
if (!isInitializing) {
    isInitializing = true;
    client.initialize().catch(err => {
        console.error('❌ Initialization failed:', err.message);
        isInitializing = false;
    });
}

// AI Response Generator - SIMPLIFIED (no business response logic)
async function generateAIResponse(contact, messageText, messageObj) {
    // Initialize conversation history for contact
    if (!conversationHistory[contact]) {
        conversationHistory[contact] = {
            messages: [],
            hasIntroduced: false,
            messageCount: 0,
            firstMessageTime: Date.now(),
            lastResponseTime: 0
        };
    }
    
    const history = conversationHistory[contact];
    history.messageCount++;
    
    // Rate limiting: Don't spam responses
    const timeSinceLastResponse = Date.now() - history.lastResponseTime;
    if (timeSinceLastResponse < 3000 && history.messageCount > 1) {
        console.log(`⏱️ Rate limiting: Too soon since last response`);
        return null;
    }
    
    // Add user message to history
    history.messages.push({
        role: 'user',
        content: messageText,
        timestamp: Date.now()
    });
    
    // Keep only last 6 messages for context (optimized)
    if (history.messages.length > 6) {
        history.messages = history.messages.slice(-6);
    }
    
    // Detect language
    const hasHindi = /[\u0900-\u097F]/.test(messageText);
    const hinglishPattern = /\b(hai|hoon|kya|kaise|kar|raha|rahe|nahi|haan|acha|theek|bhai|yaar|kahan|kab|kyu|batao|bolo|suno|achha|thik|abhi|kal|aaj|please|help)\b/i;
    const isHinglish = hinglishPattern.test(messageText) || hasHindi;
    
    // Detect emergency keywords
    const emergencyKeywords = ['emergency', 'urgent', 'help', 'critical', 'immediately', 'asap', 'zaruri', 'turant', 'jaldi', 'please help', 'SOS', 'crisis'];
    const isEmergency = emergencyKeywords.some(keyword => messageText.toLowerCase().includes(keyword));
    
    // Build system prompt
    let systemPrompt = `You are the Personal Assistant (PA) of ${aiSettings.userName || 'your boss'}.

CRITICAL RULES:
1. NEVER reveal you are an AI, bot, ChatGPT, or automated system
2. You are a HUMAN personal assistant
3. ${!history.hasIntroduced ? 'Introduce yourself briefly as ' + (aiSettings.userName || 'your boss') + '\'s PA' : 'Continue naturally'}
4. Respond in ${isHinglish ? 'Hinglish (Hindi in Roman script)' : 'English'}
5. Keep responses VERY brief (1-2 short sentences)
6. Be professional, warm, and helpful
7. If you don't know, say you'll check with ${aiSettings.userName || 'your boss'}
8. NEVER mention AI, technology, or programming terms`;
    
    if (isEmergency) {
        systemPrompt += `\n\n⚠️ EMERGENCY DETECTED: Acknowledge urgency and assure immediate escalation to ${aiSettings.userName || 'your boss'}.`;
    }
    
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.messages
    ];
    
    // Call OpenAI API with proper timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiSettings.apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: messages,
                temperature: 0.8,
                max_tokens: 120
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        const aiReply = data.choices[0].message.content.trim();
        
        // Add AI response to history
        history.messages.push({
            role: 'assistant',
            content: aiReply,
            timestamp: Date.now()
        });
        
        history.hasIntroduced = true;
        history.lastResponseTime = Date.now();
        
        // Handle emergency notification
        if (isEmergency && aiSettings.emergencyNumber) {
            try {
                const contactName = await getContactName(messageObj);
                const emergencyMsg = `🚨 EMERGENCY ALERT 🚨\n\nFrom: ${contactName}\nNumber: ${contact}\nMessage: "${messageText}"\n\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n⚠️ AI PA has responded. Please check IMMEDIATELY.`;
                
                const emergencyNumber = aiSettings.emergencyNumber.replace(/[^0-9]/g, '') + '@c.us';
                await client.sendMessage(emergencyNumber, emergencyMsg);
                console.log(`🚨 Emergency alert sent to ${aiSettings.emergencyNumber}`);
            } catch (error) {
                console.error('❌ Failed to send emergency alert:', error.message);
            }
        }
        
        return aiReply;
    } catch (error) {
        clearTimeout(timeout);
        console.error('❌ OpenAI API error:', error.message);
        throw error;
    }
}

// Helper to get contact name
async function getContactName(message) {
    try {
        const contact = await message.getContact();
        return contact.pushname || contact.name || message.from.split('@')[0];
    } catch {
        return message.from.split('@')[0];
    }
}

// Clean old conversation history (keep last 7 days)
setInterval(() => {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    for (const contact in conversationHistory) {
        if (conversationHistory[contact].firstMessageTime < sevenDaysAgo) {
            delete conversationHistory[contact];
            cleaned++;
        }
    }
    
    for (const contact in businessContacts) {
        if (!conversationHistory[contact]) {
            delete businessContacts[contact];
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} old conversation histories`);
        saveData(CONVERSATION_FILE, conversationHistory);
        saveData(BUSINESS_CONTACTS_FILE, businessContacts);
    }
}, 24 * 60 * 60 * 1000);

// Periodic data backup
setInterval(() => {
    saveData(SCHEDULED_FILE, scheduledMessages);
    saveData(REPLIES_FILE, autoReplies);
    saveData(AI_SETTINGS_FILE, aiSettings);
    saveData(CONVERSATION_FILE, conversationHistory);
    saveData(BUSINESS_CONTACTS_FILE, businessContacts);
    console.log('💾 Periodic data backup completed');
}, 5 * 60 * 1000); // Every 5 minutes

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/qr', (req, res) => {
    if (whatsappReady) {
        res.send(`
            <html>
                <head><title>WhatsApp Connected</title></head>
                <body style="text-align: center; font-family: Arial; padding: 50px; background: #dcf8c6;">
                    <h1 style="color: #25D366;">✅ WhatsApp is Connected!</h1>
                    <p style="font-size: 18px;">Your AI Personal Assistant is active.</p>
                    <a href="/" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background: #25D366; color: white; text-decoration: none; border-radius: 8px;">Go to Dashboard</a>
                </body>
            </html>
        `);
    } else if (qrCodeData) {
        res.send(`
            <html>
                <head>
                    <title>Scan QR Code</title>
                    <style>
                        body { text-align: center; font-family: Arial; padding: 50px; background: #f0f2f5; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
                        h1 { color: #25D366; }
                        img { max-width: 300px; margin: 20px 0; border: 3px solid #25D366; border-radius: 8px; }
                    </style>
                    <meta http-equiv="refresh" content="45">
                </head>
                <body>
                    <div class="container">
                        <h1>📱 Scan QR Code</h1>
                        <img src="${qrCodeData}" alt="QR Code"/>
                        <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>Loading QR Code</title>
                    <style>
                        body { text-align: center; font-family: Arial; padding: 50px; }
                        .loader { border: 5px solid #f3f3f3; border-top: 5px solid #25D366; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }
                        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    </style>
                    <meta http-equiv="refresh" content="3">
                </head>
                <body>
                    <h1>Loading QR Code...</h1>
                    <div class="loader"></div>
                </body>
            </html>
        `);
    }
});

app.get('/status', (req, res) => {
    res.json({
        whatsappConnected: whatsappReady,
        scheduledMessages: scheduledMessages.length,
        autoReplies: autoReplies.length,
        aiEnabled: aiSettings.enabled
    });
});

app.post('/scheduled-messages', (req, res) => {
    scheduledMessages = req.body;
    saveData(SCHEDULED_FILE, scheduledMessages);
    res.json({ success: true, count: scheduledMessages.length });
});

app.get('/scheduled-messages', (req, res) => {
    res.json(scheduledMessages);
});

app.post('/auto-replies', (req, res) => {
    autoReplies = req.body;
    saveData(REPLIES_FILE, autoReplies);
    res.json({ success: true, count: autoReplies.length });
});

app.get('/auto-replies', (req, res) => {
    res.json(autoReplies);
});

app.post('/ai-settings', (req, res) => {
    const newSettings = req.body;
    
    // Preserve existing API key if not provided
    if (!newSettings.apiKey || newSettings.apiKey === '***hidden***') {
        newSettings.apiKey = aiSettings.apiKey;
    }
    
    aiSettings = newSettings;
    saveData(AI_SETTINGS_FILE, aiSettings);
    console.log('💾 AI settings updated:', aiSettings.enabled ? 'Enabled ✅' : 'Disabled ❌');
    
    res.json({ success: true, aiEnabled: aiSettings.enabled });
});

app.get('/ai-settings', (req, res) => {
    res.json({
        enabled: aiSettings.enabled,
        apiKey: aiSettings.apiKey ? '***hidden***' : '',
        emergencyNumber: aiSettings.emergencyNumber,
        userName: aiSettings.userName
    });
});

// Scheduled messages cron
setInterval(async () => {
    if (!whatsappReady) return;

    const now = new Date();
    
    for (let i = scheduledMessages.length - 1; i >= 0; i--) {
        const msg = scheduledMessages[i];
        const scheduledTime = new Date(msg.datetime);
        
        if (scheduledTime <= now && msg.status === 'pending') {
            try {
                const phoneNumber = msg.phone.replace(/[^0-9]/g, '') + '@c.us';
                await client.sendMessage(phoneNumber, msg.message);
                console.log(`✅ Scheduled message sent to ${msg.phone}`);
                scheduledMessages.splice(i, 1);
                saveData(SCHEDULED_FILE, scheduledMessages);
            } catch (error) {
                console.error(`❌ Failed to send to ${msg.phone}:`, error.message);
                msg.status = 'failed';
            }
        }
    }
}, 30000); // Check every 30 seconds

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    saveData(SCHEDULED_FILE, scheduledMessages);
    saveData(REPLIES_FILE, autoReplies);
    saveData(AI_SETTINGS_FILE, aiSettings);
    saveData(CONVERSATION_FILE, conversationHistory);
    saveData(BUSINESS_CONTACTS_FILE, businessContacts);
    
    await client.destroy();
    console.log('✅ Shutdown complete');
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Dashboard: http://localhost:${PORT}`);
    console.log(`🔗 QR Code: http://localhost:${PORT}/qr`);
    console.log(`🤖 AI PA: ${aiSettings.enabled ? 'Enabled ✅' : 'Disabled ❌'}`);
});
