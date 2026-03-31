const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

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
      lastCheckIn: null,
      todayMeals: [],
      pendingMeal: null,
      profile: { height: null, weight: null, bmi: null, waterGoal: null },
      lastActive: null,
      waterReminders: 0
    };
  }
  return users[userId];
}

const MAX_PERSONALITY = `אתה "מקס" — מאמן חיים אישי בוויצאפ. אתה חוצפן, ישיר, מצחיק, ומלא אנרגיה. אתה מדבר בעברית או אנגלית לפי מה שהמשתמש כותב. אתה נחמד וחם — מברך תמיד עם "היי" או "היייי" ולא עם "יו יו יו".

🎯 המשימה שלך:
- לעזור לאנשים להגיע לפוטנציאל המקסימלי שלהם
- לשפר תזונה, כושר, שינה ואיכות חיים כללית
- להשתמש בעקרונות ביוהאקינג מדעיים

📋 תהליך היכרות (3 ימים ראשונים):
יום 1 - שאל על: שם, גיל, מטרות עיקריות (3 מטרות), שגרת יום טיפוסית, גובה ומשקל
יום 2 - שאל על: תזונה נוכחית, שעות שינה, רמת פעילות גופנית, עבודה/לחץ
יום 3 - שאל על: מה ניסו בעבר ולא עבד, מה המכשולים הגדולים, כמה זמן יש ביום לשינוי

כשמשתמש נותן גובה ומשקל — כתוב [SAVE_BMI:גובה:משקל] בתחילת התגובה.

🧠 טכניקות מוטיבציה שאתה משתמש בהן:
- רצף ימים (streak): "אתה על רצף של X ימים — אל תשבור אותו!"
- השוואה לעצמך: "לפני שבוע אמרת X, היום אתה כבר Y"
- אתגרים קטנים: "מאמין שתצליח לעשות X רק היום?"
- חיזוקים חיוביים: כשמשתמש מדווח על הצלחה — חגוג את זה בגדול!
- ציפייה: "מחר אני רוצה לשמוע איך היה האימון"

💪 סגנון תקשורת:
- הודעות קצרות וחדות (לא יותר מ-5 שורות)
- הרבה אמוג'י
- שאל שאלה אחת בסוף כל הודעה
- אל תתן יותר מדי מידע בבת אחת

אם זו ההודעה הראשונה — התחל עם ברכה אנרגטית ושאל את השם!`;

// =================== WEBHOOK VERIFICATION ===================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Webhook verification attempt:', { mode, token });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed. Token received:', token);
    res.sendStatus(403);
  }
});

// =================== WHATSAPP SEND ===================
async function sendWhatsApp(userId, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: userId,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Message sent to', userId, '| message_id:', response.data?.messages?.[0]?.id);
    return response.data;
  } catch (err) {
    console.error('sendWhatsApp error:', err.response?.data || err.message);
    throw err;
  }
}

// =================== DOWNLOAD IMAGE ===================
async function downloadImage(mediaId) {
  const mediaRes = await axios.get(
    `https://graph.facebook.com/v21.0/${mediaId}`,
    { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
  );
  const imageUrl = mediaRes.data.url;
  const imageRes = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
  });
  return {
    base64: Buffer.from(imageRes.data).toString('base64'),
    mimeType: mediaRes.data.mime_type || 'image/jpeg'
  };
}

// =================== BMI CALC ===================
function calculateBMI(height, weight) {
  const h = height / 100;
  const bmi = (weight / (h * h)).toFixed(1);
  let status = '';
  if (bmi < 18.5) status = 'תת משקל';
  else if (bmi < 25) status = 'משקל תקין ✅';
  else if (bmi < 30) status = 'עודף משקל';
  else status = 'השמנה';
  const waterGoal = Math.round(weight * 35);
  return { bmi, status, waterGoal };
}

// =================== DAILY REPORT ===================
function generateDailyReport(meals) {
  if (!meals || meals.length === 0) return null;
  let totalCalories = 0, totalProtein = 0, totalCarbs = 0;
  let totalFat = 0, totalSugar = 0;
  const minerals = {};
  for (const meal of meals) {
    const d = meal.data || meal;
    totalCalories += d.calories || 0;
    totalProtein += d.protein || 0;
    totalCarbs += d.carbs || 0;
    totalFat += d.fat || 0;
    totalSugar += d.sugar || 0;
    if (d.minerals) {
      for (const [k, v] of Object.entries(d.minerals)) {
        minerals[k] = (minerals[k] || 0) + v;
      }
    }
  }
  return { totalCalories, totalProtein, totalCarbs, totalFat, totalSugar, minerals, mealCount: meals.length };
}

// =================== ANTHROPIC CALL ===================
async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages
  };
  if (systemPrompt) body.system = systemPrompt;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    body,
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );
  return response.data.content[0].text;
}

// =================== CRON: מים כל 2 שעות ===================
cron.schedule('0 */2 * * *', async () => {
  const now = new Date();
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const hoursSinceActive = (now - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (hoursSinceActive > 24) continue;
    const waterGoal = user.profile?.waterGoal || 2500;
    const messages = [
      `💧 היי! זמן לשתות כוס מים!\nמטרה יומית שלך: ${waterGoal}ml\nהגוף שלך מודה לך 🙏`,
      `💦 תזכורת מים! אל תשכח לשתות 💪\nמים = אנרגיה = ביצועים טובים יותר!`,
      `🌊 מקס מזכיר: שתה מים עכשיו!\n${waterGoal}ml ביום זה המטרה שלך 🎯`
    ];
    const msg = messages[Math.floor(Math.random() * messages.length)];
    try { await sendWhatsApp(userId, msg); } catch (e) { console.error('Water reminder error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== CRON: תמונת גוף שבועית ===================
cron.schedule('0 9 * * 0', async () => {
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const hoursSinceActive = (new Date() - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (hoursSinceActive > 48) continue;
    try {
      await sendWhatsApp(userId,
        `📸 היי! הגיע הזמן לתמונת ההתקדמות השבועית!\n\nשלח תמונה בלי חולצה ואני אנתח:\n💪 אחוזי שומן משוערים\n📊 השוואה לשבוע שעבר\n🎯 המלצות לשיפור\n\nזה חשוב למעקב! 🔥`
      );
    } catch (e) { console.error('Weekly photo reminder error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== MAIN WEBHOOK ===================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // תמיד עונים מיד ל-Meta

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // התעלם מ-status updates (הודעות נשלחו/נקראו)
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message) return;

    console.log('Incoming message from', message.from, '| type:', message.type);

    const userId = message.from;
    const user = getUser(userId);
    user.lastActive = new Date();

    const today = new Date().toDateString();
    if (user.lastCheckIn !== today) {
      user.streak += 1;
      user.lastCheckIn = today;
      user.todayMeals = [];
      user.waterReminders = 0;
    }

    let reply = '';

    // =================== תמונת גוף ===================
    if (message.type === 'image' && user.pendingMeal === 'body_photo') {
      const { base64, mimeType } = await downloadImage(message.image.id);
      const profile = user.profile;

      reply = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text: `אתה מקס — מאמן כושר מומחה. נתח את הגוף בתמונה.
נתוני המשתמש: גובה ${profile.height || 'לא ידוע'}cm, משקל ${profile.weight || 'לא ידוע'}kg, BMI ${profile.bmi || 'לא חושב'}

תן:
📊 אחוזי שומן משוערים: X%
💪 סוג גוף: (אקטומורף/מזומורף/אנדומורף)
🎯 אזורים לשיפור: 
✅ מה נראה טוב:
💡 המלצה אחת ספציפית:

היה מעודד ומקצועי!`
          }
        ]
      }], null, 800);
      user.pendingMeal = null;

    // =================== תמונת אוכל ===================
    } else if (message.type === 'image') {
      const { base64, mimeType } = await downloadImage(message.image.id);

      const fullReply = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text: `אתה מקס — מאמן תזונה מומחה. נתח את האוכל בתמונה.
אם יש יד — השתמש בה כקנה מידה (כף יד = ~18cm).

ענה בפורמט:
🍽️ מה אני רואה: [תאר]
📏 קנה מידה: [האם יש יד? גודל מנה?]

🔥 קלוריות: ~X קק"ל
💪 חלבון: Xg
🍞 פחמימות: Xg
🍬 סוכרים: Xg
🥑 שומן: Xg

🧂 מינרלים:
• ברזל: Xmg | סידן: Xmg | אשלגן: Xmg
• מגנזיום: Xmg | נתרן: Xmg | אבץ: Xmg
• ויטמין C: Xmg | ויטמין D: Xμg | B12: Xμg

💡 טיפ אחד:

❓ האם הנתונים מדויקים? אם תרצה לתקן — כתוב לי ואעדכן. אם הכל בסדר — כתוב "שמור"

DATA:{"calories":X,"protein":X,"carbs":X,"fat":X,"sugar":X,"minerals":{"iron":X,"calcium":X,"potassium":X,"magnesium":X,"sodium":X,"zinc":X,"vitC":X,"vitD":X,"vitB12":X}}`
          }
        ]
      }], null, 1000);

      const dataMatch = fullReply.match(/DATA:(\{.*?\})/s);
      if (dataMatch) {
        try {
          user.pendingMeal = { data: JSON.parse(dataMatch[1]), time: new Date().toLocaleTimeString('he-IL') };
        } catch (e) { console.error('JSON parse error for meal data:', e.message); }
      }

      reply = fullReply.replace(/DATA:\{.*?\}/s, '').trim();

    // =================== טקסט ===================
    } else if (message.type === 'text') {
      const userMsg = message.text.body.trim();
      console.log('User message:', userMsg);

      // שמירת ארוחה
      if (userMsg === 'שמור' || userMsg.toLowerCase() === 'save') {
        if (user.pendingMeal && user.pendingMeal.data) {
          user.todayMeals.push(user.pendingMeal);
          user.pendingMeal = null;
          reply = `✅ נשמר! ${user.todayMeals.length} ארוחות מתועדות היום.\nשלח "דוח יומי" לסיכום 📊`;
        } else {
          reply = `אין ארוחה ממתינה לשמירה 😅`;
        }

      // תיקון ארוחה
      } else if (user.pendingMeal && user.pendingMeal.data) {
        const corrReply = await callClaude([{
          role: 'user',
          content: `המשתמש רוצה לתקן את הנתונים של הארוחה.
הנתונים הנוכחיים: ${JSON.stringify(user.pendingMeal.data)}
התיקון של המשתמש: "${userMsg}"

עדכן את הנתונים לפי התיקון ותן תשובה בפורמט:
✏️ עדכנתי לפי המידע שלך:
🔥 קלוריות: ~X קק"ל
💪 חלבון: Xg | 🍞 פחמימות: Xg | 🍬 סוכרים: Xg | 🥑 שומן: Xg
🧂 מינרלים: [עיקריים]

כתוב "שמור" לאישור סופי

DATA:{"calories":X,"protein":X,"carbs":X,"fat":X,"sugar":X,"minerals":{"iron":X,"calcium":X,"potassium":X,"magnesium":X,"sodium":X,"zinc":X,"vitC":X,"vitD":X,"vitB12":X}}`
        }], null, 800);

        const dataMatch = corrReply.match(/DATA:(\{.*?\})/s);
        if (dataMatch) {
          try { user.pendingMeal.data = JSON.parse(dataMatch[1]); } catch (e) {}
        }
        reply = corrReply.replace(/DATA:\{.*?\}/s, '').trim();

      // דוח יומי
      } else if (userMsg.includes('דוח יומי') || userMsg.toLowerCase().includes('daily report')) {
        const report = generateDailyReport(user.todayMeals);
        if (!report || report.mealCount === 0) {
          reply = `היי! 😅 עוד לא שלחת תמונות אוכל היום.\nשלח תמונה של הארוחה הבאה שלך ואתחיל לעקוב! 📸`;
        } else {
          reply = await callClaude([{
            role: 'user',
            content: `אתה מקס. צור דוח יומי מפורט ומעודד:

${report.mealCount} ארוחות | ${report.totalCalories} קק"ל | חלבון: ${report.totalProtein}g | פחמימות: ${report.totalCarbs}g | שומן: ${report.totalFat}g | סוכר: ${report.totalSugar}g
מטרת מים: ${user.profile?.waterGoal || 2500}ml
מינרלים: ${Object.entries(report.minerals).map(([k,v]) => `${k}: ${v}`).join(', ')}

תן:
1. סיכום קצר של היום
2. מה היה טוב
3. מה חסר (מינרלים/ויטמינים)
4. המלצה על 2-3 מאכלים להשלמת החסר
5. ציון יומי מ-10

קצר, ישיר, עם אמוג'י, מעודד!`
          }], null, 1000);
        }

      // תמונת גוף
      } else if (userMsg.includes('תמונת גוף') || userMsg.includes('אחוזי שומן')) {
        user.pendingMeal = 'body_photo';
        reply = `💪 מעולה! שלח תמונה בלי חולצה ואנתח לך:\n- אחוזי שומן משוערים\n- סוג גוף\n- המלצות אישיות\n\nוודא שהתמונה ברורה ובאור טוב 📸`;

      // שיחה רגילה
      } else {
        user.history.push({ role: 'user', content: userMsg });
        if (user.history.length > 30) user.history = user.history.slice(-30);

        const systemWithState = MAX_PERSONALITY + `\n\n📊 מצב המשתמש:\n- רצף ימים: ${user.streak}\n- יום היכרות: ${user.onboardingDay}\n- גובה: ${user.profile.height || 'לא ידוע'} | משקל: ${user.profile.weight || 'לא ידוע'} | BMI: ${user.profile.bmi || 'לא חושב'}\n- מטרת מים: ${user.profile.waterGoal || 'לא חושבה'}ml\n- ארוחות היום: ${user.todayMeals.length}`;

        let aiReply = await callClaude(user.history, systemWithState, 1000);

        // שמירת BMI
        const bmiMatch = aiReply.match(/\[SAVE_BMI:(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]/);
        if (bmiMatch) {
          const height = parseFloat(bmiMatch[1]);
          const weight = parseFloat(bmiMatch[2]);
          const { bmi, status, waterGoal } = calculateBMI(height, weight);
          user.profile.height = height;
          user.profile.weight = weight;
          user.profile.bmi = bmi;
          user.profile.waterGoal = waterGoal;
          aiReply = aiReply.replace(bmiMatch[0], '').trim();
          aiReply += `\n\n📊 BMI שלך: ${bmi} (${status})\n💧 מטרת מים יומית: ${waterGoal}ml`;
          console.log('BMI saved for', userId, ':', bmi);
        }

        reply = aiReply;
        user.history.push({ role: 'assistant', content: reply });

        if (user.onboardingDay < 3 && user.history.length > 6) {
          user.onboardingDay = Math.min(3, Math.floor(user.history.length / 6) + 1);
        }
      }

    } else {
      console.log('Unsupported message type:', message.type);
      reply = `סוג הודעה זה עדיין לא נתמך 😅 שלח טקסט או תמונה!`;
    }

    if (reply) await sendWhatsApp(userId, reply);

  } catch (err) {
    console.error('Webhook handler error:', err.response?.data || err.message);
  }
});

// Health check
app.get('/', (req, res) => res.send('מקס פועל! 🚀'));

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 מקס פועל על פורט', process.env.PORT || 3000);
  console.log('PHONE_NUMBER_ID:', PHONE_NUMBER_ID);
  console.log('WA_TOKEN set:', !!WA_TOKEN);
  console.log('ANTHROPIC_API_KEY set:', !!ANTHROPIC_API_KEY);
});
