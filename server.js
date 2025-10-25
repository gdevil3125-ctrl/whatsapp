const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Data storage
let scheduledMessages = [];
let autoReplies = [];
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

// Handle incoming messages for auto-reply
client.on('message', async (message) => {
    if (!message.fromMe) {
        const incomingText = message.body.toLowerCase().trim();
        
        // Check auto-reply rules
        for (const rule of autoReplies) {
            if (incomingText.includes(rule.trigger.toLowerCase())) {
                await message.reply(rule.response);
                console.log(`Auto-replied to: ${message.from}`);
                break;
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

// Routes
// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// API health check
app.get('/api/status', (req, res) => {
    res.json({ 
        status: 'running',
        whatsappConnected: whatsappReady,
        scheduledMessages: scheduledMessages.length,
        autoReplies: autoReplies.length
    });
});


// Get QR code for scanning
app.get('/qr', (req, res) => {
    if (whatsappReady) {
        res.send('<h1>WhatsApp is already connected!</h1>');
    } else if (qrCodeData) {
        res.send(`
            <html>
                <head><title>Scan QR Code</title></head>
                <body style="text-align: center; font-family: Arial; padding: 50px;">
                    <h1>Scan this QR Code with WhatsApp</h1>
                    <img src="${qrCodeData}" alt="QR Code" style="max-width: 400px;"/>
                    <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
                    <p>Refresh this page if QR code expires</p>
                </body>
            </html>
        `);
    } else {
        res.send('<h1>Loading QR Code... Please wait and refresh</h1>');
    }
});

// Get status
app.get('/status', (req, res) => {
    res.json({
        whatsappConnected: whatsappReady,
        scheduledMessages: scheduledMessages.length,
        autoReplies: autoReplies.length
    });
});

// Update scheduled messages
app.post('/scheduled-messages', (req, res) => {
    scheduledMessages = req.body;
    console.log('Scheduled messages updated:', scheduledMessages.length);
    res.json({ success: true, count: scheduledMessages.length });
});

// Update auto-reply rules
app.post('/auto-replies', (req, res) => {
    autoReplies = req.body;
    console.log('Auto-reply rules updated:', autoReplies.length);
    res.json({ success: true, count: autoReplies.length });
});

// Get scheduled messages
app.get('/scheduled-messages', (req, res) => {
    res.json(scheduledMessages);
});

// Get auto-reply rules
app.get('/auto-replies', (req, res) => {
    res.json(autoReplies);
});

// Cron job to check and send scheduled messages (runs every minute)
setInterval(async () => {
    if (!whatsappReady) return;

    const now = new Date();
    
    for (let i = scheduledMessages.length - 1; i >= 0; i--) {
        const msg = scheduledMessages[i];
        const scheduledTime = new Date(msg.datetime);
        
        // Check if message should be sent (within 1 minute window)
        if (scheduledTime <= now && msg.status === 'pending') {
            try {
                // Format phone number (remove + and spaces)
                const phoneNumber = msg.phone.replace(/[^0-9]/g, '') + '@c.us';
                
                // Send message
                await client.sendMessage(phoneNumber, msg.message);
                
                console.log(`Message sent to ${msg.phone}`);
                
                // Mark as sent and remove from array
                scheduledMessages.splice(i, 1);
            } catch (error) {
                console.error(`Failed to send message to ${msg.phone}:`, error.message);
                msg.status = 'failed';
            }
        }
    }
}, 60000); // Check every minute

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT}/qr to scan QR code`);
});
