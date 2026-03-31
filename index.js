const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = 'maxbot123';

const users = {};

function getUser(userId) {
  if (!users[userId]) {
    users[userId] = {
      history: [],
      onboardingDay: 1,
      streak: 0,
      lastCheckIn: null
    };
  }
  return users[userId];
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

async function sendWhatsApp(userId, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: userId,
      text: { body: text }
    },
    {
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function downloadImage(mediaId) {
  const mediaRes = await axios.get(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
  );
  const imageRes = await axios.get(mediaRes.data.url, {
    responseType: 'arraybuffer',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
  });
  return {
    base64: Buffer.from(imageRes.data).toString('base64'),
    mimeType: mediaRes.data.mime_type || 'image/jpeg'
  };
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const userId = message.from;
    const user = getUser(userId);

    const today = new Date().toDateString();
    if (user.lastCheckIn !== today) {
      user.streak += 1;
      user.lastCheckIn = today;
    }

    let reply = '';

    // תמונת אוכל
    if (message.type === 'image') {
      const { base64, mimeType } = await downloadImage(message.image.id);
      
      const imageResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64 }
              },
              {
                type: 'text',
                text: `אתה מקס — מאמן תזונה. נתח את האוכל בתמונה ותן:
🔥 קלוריות: (הערכה)
💪 חלבון: Xg
🍞 פחמימות: Xg  
🥑 שומן: Xg
💡 טיפ אחד לשיפור

הודעה קצרה, ישירה, עם אמוג'י!`
              }
            ]
          }]
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );
      reply = imageResponse.data.content[0].text;

    } else if (message.type === 'text') {
      const userMsg = message.text.body;
      user.history.push({ role: 'user', content: userMsg });
      if (user.history.length > 30) user.history = user.history.slice(-30);

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: `אתה "מקס" — מאמן חיים אישי בוויצאפ. אתה חוצפן, ישיר, מצחיק, ומלא אנרגיה. אתה מדבר בעברית או אנגלית לפי מה שהמשתמש כותב.

🎯 המשימה שלך:
- לעזור לאנשים להגיע לפוטנציאל המקסימלי שלהם
- לשפר תזונה, כושר, שינה ואיכות חיים כללית
- להשתמש בעקרונות ביוהאקינג מדעיים

📋 תהליך היכרות (3 ימים ראשונים):
יום 1 - שאל על: שם, גיל, מטרות עיקריות (3 מטרות), שגרת יום טיפוסית
יום 2 - שאל על: תזונה נוכחית, שעות שינה, רמת פעילות גופנית, עבודה/לחץ
יום 3 - שאל על: מה ניסו בעבר ולא עבד, מה המכשולים הגדולים, כמה זמן יש ביום לשינוי

🧠 טכניקות מוטיבציה:
- רצף ימים: "אתה על רצף של ${user.streak} ימים — אל תשבור אותו!"
- השוואה לעצמך: "לפני שבוע אמרת X, היום אתה כבר Y"
- אתגרים קטנים: "מאמין שתצליח לעשות X רק היום?"
- חיזוקים חיוביים על הצלחות

💪 סגנון תקשורת:
- הודעות קצרות (לא יותר מ-5 שורות)
- הרבה אמוג'י
- שאלה אחת בסוף כל הודעה

📊 מצב המשתמש:
- רצף ימים: ${user.streak}
- יום היכרות: ${user.onboardingDay}

אם זו ההודעה הראשונה — התחל עם ברכה אנרגטית ושאל את השם!`,
          messages: user.history
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );

      reply = response.data.content[0].text;
      user.history.push({ role: 'assistant', content: reply });

      if (user.onboardingDay < 3 && user.history.length > 6) {
        user.onboardingDay = Math.min(3, Math.floor(user.history.length / 6) + 1);
      }
    }

    if (reply) await sendWhatsApp(userId, reply);

  } catch (err) {
    console.error(err.response?.data || err.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('מקס פועל! 🚀'));
