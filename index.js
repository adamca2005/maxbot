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
      lastCheckIn: null,
      todayMeals: [],
      lastMealReport: null
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
יום 1 - שאל על: שם, גיל, מטרות עיקריות (3 מטרות), שגרת יום טיפוסית
יום 2 - שאל על: תזונה נוכחית, שעות שינה, רמת פעילות גופנית, עבודה/לחץ
יום 3 - שאל על: מה ניסו בעבר ולא עבד, מה המכשולים הגדולים, כמה זמן יש ביום לשינוי

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
    { messaging_product: 'whatsapp', to: userId, text: { body: text } },
    { headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
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

function generateDailyReport(meals) {
  if (!meals || meals.length === 0) return null;
  
  let totalCalories = 0, totalProtein = 0, totalCarbs = 0;
  let totalFat = 0, totalSugar = 0;
  const minerals = {};
  
  for (const meal of meals) {
    totalCalories += meal.calories || 0;
    totalProtein += meal.protein || 0;
    totalCarbs += meal.carbs || 0;
    totalFat += meal.fat || 0;
    totalSugar += meal.sugar || 0;
    if (meal.minerals) {
      for (const [k, v] of Object.entries(meal.minerals)) {
        minerals[k] = (minerals[k] || 0) + v;
      }
    }
  }
  
  return { totalCalories, totalProtein, totalCarbs, totalFat, totalSugar, minerals, mealCount: meals.length };
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
      user.todayMeals = [];
    }

    let reply = '';

    if (message.type === 'image') {
      const { base64, mimeType } = await downloadImage(message.image.id);

      const imageResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
              {
                type: 'text',
                text: `אתה מקס — מאמן תזונה מומחה. נתח את האוכל בתמונה בצורה מדויקת.

אם יש יד בתמונה — השתמש בה כקנה מידה (כף יד ממוצעת = כ-18 ס"מ).
אם אין יד — הערך לפי הצלחת/כלי ואמור שההערכה פחות מדויקת.

ענה בפורמט הזה בדיוק:
🍽️ מה אני רואה: [תאר את האוכל]
📏 קנה מידה: [האם יש יד? כמה גדולה המנה לפי הערכה?]

🔥 קלוריות: ~X קק"ל
💪 חלבון: Xg
🍞 פחמימות: Xg
🍬 סוכרים: Xg
🥑 שומן: Xg

🧂 מינרלים עיקריים:
• ברזל: Xmg
• סידן: Xmg
• אשלגן: Xmg
• מגנזיום: Xmg
• נתרן: Xmg
• אבץ: Xmg
• ויטמין C: Xmg
• ויטמין D: Xμg
• ויטמין B12: Xμg

💡 טיפ אחד לשיפור:

ואז תן JSON בשורה אחת בדיוק כך (לצורך מעקב):
DATA:{"calories":X,"protein":X,"carbs":X,"fat":X,"sugar":X,"minerals":{"iron":X,"calcium":X,"potassium":X,"magnesium":X,"sodium":X,"zinc":X,"vitC":X,"vitD":X,"vitB12":X}}`
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

      const fullReply = imageResponse.data.content[0].text;
      
      // שמירת נתוני הארוחה
      const dataMatch = fullReply.match(/DATA:(\{.*\})/);
      if (dataMatch) {
        try {
          const mealData = JSON.parse(dataMatch[1]);
          user.todayMeals.push({ ...mealData, time: new Date().toLocaleTimeString('he-IL') });
        } catch (e) {}
      }
      
      // הסרת שורת ה-DATA מהתגובה
      reply = fullReply.replace(/DATA:\{.*\}/, '').trim();
      reply += `\n\n📊 סה"כ היום: ${user.todayMeals.length} ארוחות | שלח "דוח יומי" לסיכום מלא`;

    } else if (message.type === 'text') {
      const userMsg = message.text.body;

      // בקשת דוח יומי
      if (userMsg.includes('דוח יומי') || userMsg.toLowerCase().includes('daily report')) {
        const report = generateDailyReport(user.todayMeals);
        
        if (!report || report.mealCount === 0) {
          reply = `היי! 😅 עוד לא שלחת תמונות אוכל היום.\nשלח תמונה של הארוחה הבאה שלך ואתחיל לעקוב! 📸`;
        } else {
          const reportResponse = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1000,
              messages: [{
                role: 'user',
                content: `אתה מקס — מאמן תזונה. צור דוח יומי מפורט ומעודד על בסיס הנתונים הבאים:

${report.mealCount} ארוחות היום
סה"כ: ${report.totalCalories} קק"ל | חלבון: ${report.totalProtein}g | פחמימות: ${report.totalCarbs}g | שומן: ${report.totalFat}g | סוכר: ${report.totalSugar}g

מינרלים:
${Object.entries(report.minerals).map(([k,v]) => `${k}: ${v}`).join(', ')}

תן:
1. סיכום קצר של היום
2. מה היה טוב
3. מה חסר (איזה מינרלים/ויטמינים)
4. המלצה על 2-3 מאכלים ספציפיים להשלמת החסר

סגנון: קצר, ישיר, עם אמוג'י, מעודד!`
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
          reply = reportResponse.data.content[0].text;
        }
      } else {
        // שיחה רגילה
        user.history.push({ role: 'user', content: userMsg });
        if (user.history.length > 30) user.history = user.history.slice(-30);

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: MAX_PERSONALITY + `\n\n📊 מצב המשתמש הנוכחי:\n- רצף ימים: ${user.streak}\n- יום היכרות: ${user.onboardingDay}\n- ארוחות היום: ${user.todayMeals.length}`,
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
    }

    if (reply) await sendWhatsApp(userId, reply);

  } catch (err) {
    console.error(err.response?.data || err.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('מקס פועל! 🚀'));
