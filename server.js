const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Data storage
let scheduledMessages = [];
let autoReplies = [];
let aiSettings = { enabled: false, apiKey: '', emergencyNumber: '', userName: '' };
let conversationHistory = {}; // Store conversation context per contact
let qrCodeData = null;
let whatsappReady = false;

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// QR Code generation
client.on('qr', async (qr) => {
    console.log('QR Code received, scan with WhatsApp app');
    qrCodeData = await qrcode.toDataURL(qr);
});

// WhatsApp ready
client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    whatsappReady = true;
    qrCodeData = null;
});

// Handle incoming messages
client.on('message', async (message) => {
    if (!message.fromMe) {
        const incomingText = message.body.trim();
        const contact = message.from;
        
        // Check keyword-based auto-reply rules first
        const incomingLower = incomingText.toLowerCase();
        for (const rule of autoReplies) {
            if (incomingLower.includes(rule.trigger.toLowerCase())) {
                await message.reply(rule.response);
                console.log(`Auto-replied to: ${contact}`);
                return; // Exit after keyword match
            }
        }
        
        // If AI is enabled, use intelligent responses
        if (aiSettings.enabled && aiSettings.apiKey) {
            try {
                const aiResponse = await generateAIResponse(contact, incomingText, message);
                if (aiResponse) {
                    await message.reply(aiResponse);
                    console.log(`AI replied to: ${contact}`);
                }
            } catch (error) {
                console.error('AI response error:', error.message);
            }
        }
    }
});

// Handle disconnection
client.on('disconnected', (reason) => {
    console.log('WhatsApp disconnected:', reason);
    whatsappReady = false;
});

// Initialize WhatsApp client
client.initialize();

// AI Response Generator
async function generateAIResponse(contact, messageText, messageObj) {
    if (!conversationHistory[contact]) {
        conversationHistory[contact] = {
            messages: [],
            hasIntroduced: false
        };
    }
    
    const history = conversationHistory[contact];
    
    // Add user message to history
    history.messages.push({
        role: 'user',
        content: messageText
    });
    
    // Keep only last 10 messages for context
    if (history.messages.length > 10) {
        history.messages = history.messages.slice(-10);
    }
    
    // Detect language (simple detection)
    const hasHindi = /[\u0900-\u097F]/.test(messageText);
    const hinglishPattern = /\b(hai|hoon|kya|kaise|kar|raha|rahe|nahi|haan|acha|theek|bhai|yaar|kahan|kab|kyu|batao|bolo|suno)\b/i;
    const isHinglish = hinglishPattern.test(messageText) || hasHindi;
    
    // Detect emergency keywords
    const emergencyKeywords = ['emergency', 'urgent', 'help', 'critical', 'immediately', 'asap', 'zaruri', 'turant', 'jaldi', 'please help'];
    const isEmergency = emergencyKeywords.some(keyword => messageText.toLowerCase().includes(keyword));
    
    // Build system prompt
    const systemPrompt = `You are the Personal Assistant (PA) of ${aiSettings.userName || 'your boss'}. 

CRITICAL RULES:
1. NEVER reveal you are an AI, LLM, bot, ChatGPT, or automated system
2. You are a HUMAN personal assistant - respond naturally as a professional PA would
3. ${!history.hasIntroduced ? 'Start by politely introducing yourself as ' + (aiSettings.userName || 'your boss') + '\'s PA and ask how you can help them' : 'Continue the conversation naturally'}
4. Respond in ${isHinglish ? 'Hinglish (mix of Hindi written in English/Roman script like "Haan main unka PA hoon, kaise help kar sakta hoon?"' : 'English'}
5. Be professional, helpful, warm and courteous
6. If asked who you are or if you're a bot, say you're ${aiSettings.userName || 'your boss'}'s personal assistant who manages their messages
7. Keep responses brief and natural (1-3 sentences max, like a real PA would text)
8. If you don't know something specific, say you'll check with ${aiSettings.userName || 'your boss'} and get back to them
9. Never mention AI, machine learning, programming, or technical terms
10. Text like a human - use casual language, contractions, and natural flow

CURRENT SITUATION:
${isEmergency ? '⚠️ EMERGENCY detected. Acknowledge urgency professionally and assure immediate attention to ' + (aiSettings.userName || 'your boss') + '.' : 'Normal conversation - be friendly and helpful'}

Respond naturally as a human PA would via WhatsApp message.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.messages
    ];
    
    // Call OpenAI API
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
            max_tokens: 150
        })
    });
    
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
            const emergencyMsg = `🚨 EMERGENCY ALERT 🚨\n\nFrom: ${contactName}\nNumber: ${contact}\nMessage: "${messageText}"\n\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n⚠️ AI PA has responded to the sender. Please check and follow up immediately.`;
            
            const emergencyNumber = aiSettings.emergencyNumber.replace(/[^0-9]/g, '') + '@c.us';
            await client.sendMessage(emergencyNumber, emergencyMsg);
            console.log(`🚨 Emergency alert sent to ${aiSettings.emergencyNumber}`);
        } catch (error) {
            console.error('Failed to send emergency alert:', error);
        }
    }
    
    return aiReply;
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

// Routes

// Serve HTML dashboard at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Get QR code for scanning
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

// Get status
app.get('/status', (req, res) => {
    res.json({
        whatsappConnected: whatsappReady,
        scheduledMessages: scheduledMessages.length,
        autoReplies: autoReplies.length,
        aiEnabled: aiSettings.enabled
    });
});

// API health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'running',
        whatsappConnected: whatsappReady,
        scheduledMessages: scheduledMessages.length,
        autoReplies: autoReplies.length,
        aiEnabled: aiSettings.enabled
    });
});

// Update scheduled messages
app.post('/scheduled-messages', (req, res) => {
    scheduledMessages = req.body;
    console.log('Scheduled messages updated:', scheduledMessages.length);
    res.json({ success: true, count: scheduledMessages.length });
});

// Get scheduled messages
app.get('/scheduled-messages', (req, res) => {
    res.json(scheduledMessages);
});

// Update auto-reply rules
app.post('/auto-replies', (req, res) => {
    autoReplies = req.body;
    console.log('Auto-reply rules updated:', autoReplies.length);
    res.json({ success: true, count: autoReplies.length });
});

// Get auto-reply rules
app.get('/auto-replies', (req, res) => {
    res.json(autoReplies);
});

// Update AI settings
app.post('/ai-settings', (req, res) => {
    aiSettings = req.body;
    console.log('AI settings updated:', aiSettings.enabled ? 'Enabled ✅' : 'Disabled ❌');
    if (aiSettings.enabled) {
        console.log(`AI PA active for: ${aiSettings.userName}`);
        console.log(`Emergency alerts to: ${aiSettings.emergencyNumber}`);
    }
    res.json({ success: true, aiEnabled: aiSettings.enabled });
});

// Get AI settings
app.get('/ai-settings', (req, res) => {
    // Return settings but hide API key (only show if it exists)
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
            } catch (error) {
                console.error(`❌ Failed to send message to ${msg.phone}:`, error.message);
                msg.status = 'failed';
            }
        }
    }
}, 60000); // Check every minute

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Dashboard: http://localhost:${PORT}`);
    console.log(`🔗 QR Code: http://localhost:${PORT}/qr`);
    console.log(`🤖 AI PA: ${aiSettings.enabled ? 'Enabled ✅' : 'Disabled ❌'}`);
});
