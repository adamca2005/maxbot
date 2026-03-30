const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = 'maxbot123';

const users = {};

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    
    if (!message || message.type !== 'text') return;
    
    const userId = message.from;
    const userMsg = message.text.body;
    
    if (!users[userId]) users[userId] = [];
    users[userId].push({ role: 'user', content: userMsg });
    if (users[userId].length > 20) users[userId] = users[userId].slice(-20);
    
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'אתה מקס — מאמן חיים אישי. חוצפן, ישיר, מצחיק, מלא אנרגיה. עוזר עם תזונה, כושר, שינה וביוהאקינג. הודעות קצרות, הרבה אמוג\'י, שאלה אחת בסוף.',
        messages: users[userId]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );
    
    const reply = response.data.content[0].text;
    users[userId].push({ role: 'assistant', content: reply });
    
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: userId,
        text: { body: reply }
      },
      {
        headers: {
          'Authorization': `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('מקס פועל! 🚀'));
