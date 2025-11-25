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

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load persisted data
function loadData(filepath, defaultValue = []) {
    try {
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf8'));
        }
    } catch (error) {
        console.error(`Error loading ${filepath}:`, error.message);
    }
    return defaultValue;
}

// Save data to file
function saveData(filepath, data) {
    try {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error saving ${filepath}:`, error.message);
    }
}

// Data storage with persistence
let scheduledMessages = loadData(SCHEDULED_FILE, []);
let autoReplies = loadData(REPLIES_FILE, []);
let aiSettings = loadData(AI_SETTINGS_FILE, { enabled: false, apiKey: '', emergencyNumber: '', userName: '' });
let conversationHistory = loadData(CONVERSATION_FILE, {});
let qrCodeData = null;
let whatsappReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Initialize WhatsApp Client with better stability
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth')
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
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ],
        timeout: 60000
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

// QR Code generation
client.on('qr', async (qr) => {
    console.log('📱 QR Code received, scan with WhatsApp app');
    qrCodeData = await qrcode.toDataURL(qr);
    reconnectAttempts = 0;
});

// WhatsApp ready
client.on('ready', () => {
    console.log('✅ WhatsApp Client is ready!');
    whatsappReady = true;
    qrCodeData = null;
    reconnectAttempts = 0;
});

// WhatsApp authenticated
client.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated successfully');
});

// Authentication failure
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
    whatsappReady = false;
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
        setTimeout(() => {
            client.initialize();
        }, 5000);
    }
});

// Handle incoming messages with business detection
client.on('message', async (message) => {
    if (!message.fromMe) {
        const incomingText = message.body.trim();
        const contact = message.from;
        
        // Check keyword-based auto-reply rules first
        const incomingLower = incomingText.toLowerCase();
        for (const rule of autoReplies) {
            if (incomingLower.includes(rule.trigger.toLowerCase())) {
                await message.reply(rule.response);
                console.log(`💬 Auto-replied to: ${contact}`);
                return;
            }
        }
        
        // If AI is enabled, use intelligent responses
        if (aiSettings.enabled && aiSettings.apiKey) {
            try {
                const aiResponse = await generateAIResponse(contact, incomingText, message);
                if (aiResponse) {
                    await message.reply(aiResponse);
                    console.log(`🤖 AI replied to: ${contact}`);
                    
                    // Save conversation history after response
                    saveData(CONVERSATION_FILE, conversationHistory);
                }
            } catch (error) {
                console.error('❌ AI response error:', error.message);
            }
        }
    }
});

// Handle disconnection with auto-reconnect
client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp disconnected:', reason);
    whatsappReady = false;
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Auto-reconnecting... Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        setTimeout(() => {
            client.initialize();
        }, 10000);
    } else {
        console.error('❌ Max reconnection attempts reached. Please restart the server or rescan QR code.');
    }
});

// Keep connection alive
setInterval(() => {
    if (whatsappReady) {
        client.getState().then(state => {
            if (state !== 'CONNECTED') {
                console.log('⚠️ Connection state changed:', state);
                whatsappReady = false;
            }
        }).catch(() => {
            console.log('⚠️ Connection check failed');
            whatsappReady = false;
        });
    }
}, 30000);

// Initialize WhatsApp client
client.initialize();

// AI Response Generator with business detection
async function generateAIResponse(contact, messageText, messageObj) {
    if (!conversationHistory[contact]) {
        conversationHistory[contact] = {
            messages: [],
            hasIntroduced: false,
            messageCount: 0,
            isBusiness: false,
            firstMessageTime: Date.now()
        };
    }
    
    const history = conversationHistory[contact];
    history.messageCount++;
    
    // Detect if this is a business account
    try {
        const chatContact = await messageObj.getContact();
        if (chatContact.isBusiness) {
            history.isBusiness = true;
        }
    } catch (error) {
        // Continue if contact info unavailable
    }
    
    // Business detection heuristics
    const businessKeywords = [
        'order', 'delivery', 'payment', 'invoice', 'booking', 'appointment',
        'service', 'product', 'price', 'cost', 'purchase', 'buy',
        'confirm', 'verification', 'otp', 'code', 'account', 'subscription'
    ];
    const containsBusinessKeywords = businessKeywords.some(keyword => 
        messageText.toLowerCase().includes(keyword)
    );
    
    if (containsBusinessKeywords) {
        history.isBusiness = true;
    }
    
    // For businesses: Only reply ONCE with brief introduction
    if (history.isBusiness && history.messageCount > 1) {
        console.log(`🚫 Skipping business reply for ${contact} (message #${history.messageCount})`);
        return null; // Don't respond to subsequent business messages
    }
    
    // Add user message to history
    history.messages.push({
        role: 'user',
        content: messageText
    });
    
    // Keep only last 8 messages for context (reduced for efficiency)
    if (history.messages.length > 8) {
        history.messages = history.messages.slice(-8);
    }
    
    // Detect language
    const hasHindi = /[\u0900-\u097F]/.test(messageText);
    const hinglishPattern = /\b(hai|hoon|kya|kaise|kar|raha|rahe|nahi|haan|acha|theek|bhai|yaar|kahan|kab|kyu|batao|bolo|suno|achha|thik|abhi|kal|aaj)\b/i;
    const isHinglish = hinglishPattern.test(messageText) || hasHindi;
    
    // Detect emergency keywords
    const emergencyKeywords = ['emergency', 'urgent', 'help', 'critical', 'immediately', 'asap', 'zaruri', 'turant', 'jaldi', 'please help', 'SOS'];
    const isEmergency = emergencyKeywords.some(keyword => messageText.toLowerCase().includes(keyword));
    
    // Build system prompt
    const businessInstruction = history.isBusiness 
        ? '\n\n🚨 BUSINESS DETECTED: This appears to be an automated business message (order/delivery/OTP etc). Give ONE brief, polite acknowledgment ONLY. Do not engage in conversation. Keep it under 15 words.'
        : '';
    
    const systemPrompt = `You are the Personal Assistant (PA) of ${aiSettings.userName || 'your boss'}. 

CRITICAL RULES:
1. NEVER reveal you are an AI, LLM, bot, ChatGPT, or automated system
2. You are a HUMAN personal assistant - respond naturally as a professional PA would
3. ${!history.hasIntroduced ? 'Start by politely introducing yourself as ' + (aiSettings.userName || 'your boss') + '\'s PA and ask how you can help them' : 'Continue the conversation naturally'}
4. Respond in ${isHinglish ? 'Hinglish (mix of Hindi written in English/Roman script like "Haan main unka PA hoon, kaise help kar sakta hoon?")' : 'English'}
5. Be professional, helpful, warm and courteous
6. If asked who you are or if you're a bot, say you're ${aiSettings.userName || 'your boss'}'s personal assistant who manages their messages
7. Keep responses VERY brief (1-2 sentences max, like a real PA would text)
8. If you don't know something specific, say you'll check with ${aiSettings.userName || 'your boss'} and get back to them
9. Never mention AI, machine learning, programming, or technical terms
10. Text like a human - use casual language, contractions, and natural flow
${businessInstruction}

CURRENT SITUATION:
${isEmergency ? '⚠️ EMERGENCY detected. Acknowledge urgency professionally and assure immediate attention to ' + (aiSettings.userName || 'your boss') + '.' : 'Normal conversation - be friendly and helpful'}

Respond naturally as a human PA would via WhatsApp message.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.messages
    ];
    
    // Call OpenAI API with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
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
                temperature: 0.9,
                max_tokens: history.isBusiness ? 50 : 150
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
            content: aiReply
        });
        
        // Mark as introduced after first message
        if (!history.hasIntroduced) {
            history.hasIntroduced = true;
        }
        
        // Handle emergency notification
        if (isEmergency && aiSettings.emergencyNumber) {
            try {
                const contactName = await getContactName(messageObj);
                const emergencyMsg = `🚨 EMERGENCY ALERT 🚨\n\nFrom: ${contactName}\nNumber: ${contact}\nMessage: "${messageText}"\n\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n⚠️ AI PA has responded. Please check and follow up IMMEDIATELY.`;
                
                const emergencyNumber = aiSettings.emergencyNumber.replace(/[^0-9]/g, '') + '@c.us';
                await client.sendMessage(emergencyNumber, emergencyMsg);
                console.log(`🚨 Emergency alert sent to ${aiSettings.emergencyNumber}`);
            } catch (error) {
                console.error('❌ Failed to send emergency alert:', error);
            }
        }
        
        return aiReply;
    } catch (error) {
        clearTimeout(timeout);
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
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} old conversation histories`);
        saveData(CONVERSATION_FILE, conversationHistory);
    }
}, 24 * 60 * 60 * 1000); // Run daily

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
                    <p style="font-size: 18px;">Your AI Personal Assistant is active and responding to messages.</p>
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
                        .steps { text-align: left; margin: 20px 0; }
                        .step { margin: 10px 0; padding: 10px; background: #f0f2f5; border-radius: 6px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>📱 Scan QR Code</h1>
                        <img src="${qrCodeData}" alt="QR Code"/>
                        <div class="steps">
                            <div class="step"><strong>Step 1:</strong> Open WhatsApp on your phone</div>
                            <div class="step"><strong>Step 2:</strong> Go to Settings → Linked Devices</div>
                            <div class="step"><strong>Step 3:</strong> Tap "Link a Device"</div>
                            <div class="step"><strong>Step 4:</strong> Scan this QR code</div>
                        </div>
                        <p style="color: #666; font-size: 14px;">⏰ QR code expires in 60 seconds. Refresh if needed.</p>
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
                    <p>Please wait... Page will refresh automatically.</p>
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

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'running',
        whatsappConnected: whatsappReady,
        scheduledMessages: scheduledMessages.length,
        autoReplies: autoReplies.length,
        aiEnabled: aiSettings.enabled
    });
});

app.post('/scheduled-messages', (req, res) => {
    scheduledMessages = req.body;
    saveData(SCHEDULED_FILE, scheduledMessages);
    console.log('💾 Scheduled messages updated:', scheduledMessages.length);
    res.json({ success: true, count: scheduledMessages.length });
});

app.get('/scheduled-messages', (req, res) => {
    res.json(scheduledMessages);
});

app.post('/auto-replies', (req, res) => {
    autoReplies = req.body;
    saveData(REPLIES_FILE, autoReplies);
    console.log('💾 Auto-reply rules updated:', autoReplies.length);
    res.json({ success: true, count: autoReplies.length });
});

app.get('/auto-replies', (req, res) => {
    res.json(autoReplies);
});

app.post('/ai-settings', (req, res) => {
    aiSettings = req.body;
    saveData(AI_SETTINGS_FILE, aiSettings);
    console.log('💾 AI settings updated:', aiSettings.enabled ? 'Enabled ✅' : 'Disabled ❌');
    if (aiSettings.enabled) {
        console.log(`🤖 AI PA active for: ${aiSettings.userName}`);
        console.log(`🚨 Emergency alerts to: ${aiSettings.emergencyNumber}`);
    }
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

// Cron job to check and send scheduled messages
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
                console.error(`❌ Failed to send message to ${msg.phone}:`, error.message);
                msg.status = 'failed';
            }
        }
    }
}, 60000);

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Save all data
    saveData(SCHEDULED_FILE, scheduledMessages);
    saveData(REPLIES_FILE, autoReplies);
    saveData(AI_SETTINGS_FILE, aiSettings);
    saveData(CONVERSATION_FILE, conversationHistory);
    
    // Destroy WhatsApp client
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
    console.log(`💾 Data persistence: ENABLED`);
});
