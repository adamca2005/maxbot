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
      profile: {
        height: null, weight: null, bmi: null, waterGoal: null,
        age: null, name: null, goals: []
      },
      medicalHistory: {
        conditions: [],       // מחלות כרוניות
        medications: [],      // תרופות
        allergies: [],        // אלרגיות
        bloodTests: [],       // בדיקות דם היסטוריה
        lastBloodTest: null,  // בדיקה אחרונה
        medicalAsked: false   // האם כבר שאלנו היסטוריה רפואית
      },
      lastActive: null,
      waterReminders: 0,
      weeklyChallenge: null,
      challengeCompleted: false,
      workoutPlan: null,
      shownCapabilities: [],  // יכולות שכבר הוצגו
      smartReminders: {
        lastWorkoutReminder: null,
        lastSleepReminder: null,
        lastNutritionTip: null,
        missedDays: 0
      }
    };
  }
  return users[userId];
}

// =================== MAX PERSONALITY ===================
const MAX_PERSONALITY = `אתה "מקס" — מאמן חיים אישי בוויצאפ. אתה חוצפן, ישיר, מצחיק, ומלא אנרגיה. אתה מדבר בעברית או אנגלית לפי מה שהמשתמש כותב. אתה נחמד וחם — מברך תמיד עם "היי" או "היייי" ולא עם "יו יו יו".

🎯 המשימה שלך:
- לעזור לאנשים להגיע לפוטנציאל המקסימלי שלהם
- לשפר תזונה, כושר, שינה ואיכות חיים כללית
- להשתמש בעקרונות ביוהאקינג מדעיים
- לשמש כמנחה דרך רפואי — לא להחליף רופא אלא לכוון ולהתריע

📋 תהליך היכרות (3 ימים ראשונים):
יום 1 - שאל על: שם, גיל, מטרות עיקריות, שגרת יום, גובה ומשקל
יום 2 - שאל על: תזונה נוכחית, שעות שינה, רמת פעילות גופנית, עבודה/לחץ
יום 3 - שאל על: מה ניסו בעבר ולא עבד, מכשולים גדולים, כמה זמן יש לשינוי

כשמשתמש נותן גובה ומשקל — כתוב [SAVE_BMI:גובה:משקל] בתחילת התגובה.
כשמשתמש נותן שם — כתוב [SAVE_NAME:שם] בתחילת התגובה.
כשמשתמש נותן גיל — כתוב [SAVE_AGE:גיל] בתחילת התגובה.

🧠 טכניקות מוטיבציה:
- רצף ימים (streak): "אתה על רצף של X ימים — אל תשבור אותו!"
- השוואה לעצמך: "לפני שבוע אמרת X, היום אתה כבר Y"
- אתגרים קטנים: "מאמין שתצליח לעשות X רק היום?"
- חיזוקים חיוביים: כשמשתמש מדווח על הצלחה — חגוג!
- ציפייה: "מחר אני רוצה לשמוע איך היה האימון"

💡 הצגת יכולות — חשוב מאוד:
הצג יכולת חדשה רק כשיש הקשר טבעי בשיחה. לדוגמה:
- אם המשתמש מדבר על עייפות → "אגב, אני יכול לנתח בדיקות דם ולבדוק אם יש לך חוסר ברזל או ויטמין D 🔬"
- אם מדבר על כושר → "אגב, אני יכול לבנות לך תוכנית אימונים שבועית + סרטוני יוטיוב לכל תרגיל 💪"
- אם מדבר על תזונה → "אגב, אני יכול לנתח תמונות של האוכל שלך ולחשב קלוריות ומינרלים 📸"

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
  console.log('Webhook verification:', { mode, token });
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
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
      { headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('Sent to', userId);
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
  const imageRes = await axios.get(mediaRes.data.url, {
    responseType: 'arraybuffer',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
  });
  return {
    base64: Buffer.from(imageRes.data).toString('base64'),
    mimeType: mediaRes.data.mime_type || 'image/jpeg'
  };
}

// =================== BMI ===================
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
  let totalCalories = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0, totalSugar = 0;
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

// =================== CLAUDE API ===================
async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages };
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

// =================== YOUTUBE RECOMMENDATIONS ===================
async function getYouTubeRecommendations(topic, type = 'exercise') {
  // מקס מייצר המלצות יוטיוב חכמות לפי נושא
  const prompt = type === 'exercise'
    ? `אתה מקס. המשתמש צריך סרטוני יוטיוב לתרגיל/כושר: "${topic}"
      
תן 3 המלצות חיפוש ביוטיוב בפורמט:

🎬 סרטונים מומלצים ביוטיוב לـ"${topic}":

1️⃣ חפש: "[מחרוזת חיפוש מדויקת באנגלית]"
   📝 [מה תלמד מהסרטון הזה - משפט אחד]

2️⃣ חפש: "[מחרוזת חיפוש מדויקת באנגלית]"
   📝 [מה תלמד]

3️⃣ חפש: "[מחרוזת חיפוש מדויקת באנגלית]"
   📝 [מה תלמד]

💡 טיפ: חפש ב-YouTube את המחרוזות האלה בדיוק לתוצאות הטובות ביותר!`
    : `אתה מקס. המשתמש רוצה ללמוד על הנושא: "${topic}" (ויטמינים/הורמונים/בריאות)

תן 3 המלצות סרטונים חינוכיים:

🎓 סרטונים מומלצים ביוטיוב על "${topic}":

1️⃣ חפש: "[מחרוזת חיפוש מדויקת באנגלית]"
   📝 [מה תלמד - ברמה מדעית/נגישה]

2️⃣ חפש: "[מחרוזת חיפוש מדויקת באנגלית]"  
   📝 [זווית שונה על הנושא]

3️⃣ חפש: "[מחרוזת חיפוש מדויקת באנגלית - עברית אם קיים]"
   📝 [תוכן בעברית אם אפשר]

💡 ערוצים מומלצים לנושא זה: [2-3 ערוצים רלוונטיים]`;

  return await callClaude([{ role: 'user', content: prompt }], null, 600);
}

// =================== MEDICAL HISTORY QUESTION ===================
function getMedicalHistoryQuestion() {
  return `🏥 לפני שממשיכים — אני רוצה להכיר אותך טוב יותר כדי לתת לך ייעוץ מדויק!

שאלה אחת חשובה: האם יש לך:
1. מחלות כרוניות? (סוכרת, לחץ דם, בעיות לב וכו׳)
2. תרופות שאתה לוקח?
3. אלרגיות למזון?

כתוב הכל בחופשיות — זה נשאר בינינו 🔒
אם אין כלום — כתוב "בריא לחלוטין" ונמשיך 💪

⚠️ תזכורת: אני מנחה דרך ולא מחליף רופא — תמיד להתייעץ עם רופא לגבי שינויים רפואיים משמעותיים.`;
}

// =================== BLOOD TEST ANALYSIS ===================
async function analyzeBloodTest(testData, userProfile, medicalHistory) {
  const prompt = `אתה מקס — מנחה בריאות מומחה. נתח את תוצאות בדיקת הדם הבאות.

פרופיל המשתמש:
- גיל: ${userProfile.age || 'לא ידוע'} | גובה: ${userProfile.height || 'לא ידוע'}cm | משקל: ${userProfile.weight || 'לא ידוע'}kg
- מחלות ידועות: ${medicalHistory.conditions.join(', ') || 'אין'}
- תרופות: ${medicalHistory.medications.join(', ') || 'אין'}

תוצאות הבדיקה:
${testData}

נתח לפי הפורמט הבא:

🔬 ניתוח בדיקות דם — מקס:

✅ תקין:
[ערכים שבתחום הנורמה]

⚠️ דורש תשומת לב:
[ערכים גבוליים עם הסבר]

🚨 חריג — ממליץ לדון עם רופא:
[ערכים חריגים ומה המשמעות]

💊 חוסרים שזוהו:
[ויטמינים/מינרלים נמוכים + מקורות מזון להשלמה]

📈 עודפים שזוהו:
[ערכים גבוהים מדי ומה כדאי להפחית]

🔗 שילובים מעניינים:
[קשרים בין הערכים שעשויים להעיד על משהו]

🥗 המלצות תזונה לפי הבדיקה:
[3 המלצות ספציפיות]

⚕️ חשוב: אני מנחה דרך ולא רופא — שתף את הממצאים האלה עם הרופא שלך לאישור!`;

  return await callClaude([{ role: 'user', content: prompt }], null, 1500);
}

// =================== SMART REMINDERS ENGINE ===================
async function generateSmartReminder(user, userId) {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const profile = user.profile;
  const reminders = user.smartReminders;

  // בוקר (6-9) — תזכורת שגרת בוקר
  if (hour >= 6 && hour <= 9) {
    const tips = [
      `☀️ ${profile.name || 'היי'}! בוקר טוב!\n\n🥛 שתה כוס מים עם לימון עכשיו\n☀️ 10 דקות שמש = ויטמין D טבעי\n🧘 3 נשימות עמוקות לפני הטלפון\n\nהיום אתה על רצף של ${user.streak} ימים 🔥`,
      `🌅 ${profile.name || 'היי'}! הגוף שלך מחכה לך!\n\n💪 5 דקות מתיחות עכשיו = אנרגיה לכל היום\n🥚 ארוחת בוקר עם חלבון = פוקוס מקסימלי\n\nמה האימון שלך היום? 💪`
    ];
    return tips[Math.floor(Math.random() * tips.length)];
  }

  // אחה"צ (14-16) — תזכורת אנרגיה
  if (hour >= 14 && hour <= 16) {
    return `⚡ ${profile.name || 'היי'}! הדיפ של אחה"צ מגיע...\n\n💡 במקום קפה:\n• כוס מים קרה + הליכה 5 דק׳\n• חופן אגוזים לאנרגיה יציבה\n• 10 קפיצות להחייאת הגוף\n\nהגוף שלך מבקש ${profile.waterGoal || 2500}ml מים ביום 💧\nכמה שתית עד עכשיו?`;
  }

  // ערב (19-21) — סיכום יום
  if (hour >= 19 && hour <= 21) {
    const mealCount = user.todayMeals.length;
    return `🌙 ${profile.name || 'היי'}! סיכום יום מהיר:\n\n${mealCount > 0 ? `📸 תיעדת ${mealCount} ארוחות — כל הכבוד!` : '📸 עוד לא תיעדת ארוחות היום — שלח תמונה!'}\n💧 שתית מספיק מים?\n😴 מטרת שינה: 22:30 לשינה איכותית\n\nשלח "דוח יומי" לסיכום מלא 📊`;
  }

  // יום ב׳/ה׳ — תזכורת אימון
  if ((dayOfWeek === 1 || dayOfWeek === 4) && !reminders.lastWorkoutReminder) {
    reminders.lastWorkoutReminder = now;
    return `💪 ${profile.name || 'היי'}! יום אימון מושלם היום!\n\nלא פספסת? 🏃‍♂️\nשלח "תוכנית אימונים" אם צריך תוכנית\nאו שלח סרטון/תמונה מהאימון ואתגיב 🔥\n\nהרצף שלך: ${user.streak} ימים 🔥`;
  }

  return null;
}

// =================== CAPABILITY HINTS ===================
function getCapabilityHint(message, user) {
  const shown = user.shownCapabilities || [];
  const msg = message.toLowerCase();

  const capabilities = [
    {
      id: 'blood_test',
      triggers: ['עייפות', 'עייף', 'חלש', 'אנרגיה נמוכה', 'שיער', 'ציפורניים', 'ריכוז'],
      hint: `\n\n🔬 אגב — אני יכול לנתח בדיקות דם ולזהות חוסרים בויטמינים ומינרלים. יש לך בדיקות אחרונות? שלח את הערכים ואבדוק!`
    },
    {
      id: 'youtube_exercise',
      triggers: ['תרגיל', 'אימון', 'כושר', 'שריר', 'בטן', 'גב', 'רגליים', 'כתפיים'],
      hint: `\n\n🎬 אגב — אני יכול לשלוח לך סרטוני יוטיוב מדויקים לכל תרגיל! רוצה המלצות?`
    },
    {
      id: 'youtube_health',
      triggers: ['ויטמין', 'הורמון', 'קורטיזול', 'טסטוסטרון', 'אינסולין', 'תיירואיד', 'מגנזיום'],
      hint: `\n\n🎓 אגב — יש סרטונים מעולים ביוטיוב על הנושא הזה. רוצה שאמליץ לך על הטובים ביותר?`
    },
    {
      id: 'food_photo',
      triggers: ['אכלתי', 'אוכל', 'ארוחה', 'קלוריות', 'מה לאכול'],
      hint: `\n\n📸 אגב — אני יכול לנתח תמונות של האוכל שלך ולחשב קלוריות, חלבון ומינרלים באופן אוטומטי!`
    },
    {
      id: 'medical_history',
      triggers: ['כאב', 'בעיה', 'מחלה', 'תרופה', 'רופא', 'בריאות'],
      hint: `\n\n🏥 אגב — לא שאלתי אותך עדיין על ההיסטוריה הרפואית שלך. זה עוזר לי לתת עצות מדויקות יותר. נעשה את זה?`
    }
  ];

  for (const cap of capabilities) {
    if (!shown.includes(cap.id) && cap.triggers.some(t => msg.includes(t))) {
      user.shownCapabilities.push(cap.id);
      return cap.hint;
    }
  }
  return '';
}

// =================== GENERATE WEEKLY CHALLENGE ===================
async function generateWeeklyChallenge(user) {
  const profile = user.profile;
  return await callClaude([{
    role: 'user',
    content: `אתה מקס — מאמן חיים. צור אתגר שבועי אחד מותאם אישית.
פרופיל: גובה ${profile.height || 'לא ידוע'}cm, משקל ${profile.weight || 'לא ידוע'}kg, רצף: ${user.streak} ימים
מחלות ידועות: ${user.medicalHistory.conditions.join(', ') || 'אין'}

האתגר: ריאלי, ספציפי, מדיד תוך שבוע.

🏆 האתגר השבועי שלך:
[שם]

📋 המשימה: [תיאור ספציפי]
🎯 הצלחה: [קריטריון ברור]
💡 טיפ: [טיפ אחד]

כשתסיים — כתוב "השלמתי אתגר" 🎉`
  }], null, 500);
}

// =================== GENERATE WORKOUT PLAN ===================
async function generateWorkoutPlan(user) {
  const profile = user.profile;
  const med = user.medicalHistory;
  return await callClaude([{
    role: 'user',
    content: `אתה מקס — מאמן כושר. בנה תוכנית אימונים שבועית מותאמת.

פרופיל:
- גובה: ${profile.height || 'לא ידוע'}cm | משקל: ${profile.weight || 'לא ידוע'}kg | BMI: ${profile.bmi || 'לא ידוע'}
- גיל: ${profile.age || 'לא ידוע'} | רצף: ${user.streak} ימים
- מגבלות רפואיות: ${med.conditions.join(', ') || 'אין'}
- תרופות: ${med.medications.join(', ') || 'אין'}

💪 תוכנית האימונים השבועית:

📅 יום א׳ — [שם]:
• [תרגיל]: X סטים × X חזרות
[המשך ל-7 ימים כולל מנוחה]

⏱️ זמן ליום: ~X דקות
💡 טיפ חשוב: [אחד]`
  }], null, 1500);
}

// =================== CRON: ציטוט בוקר 8:00 ===================
cron.schedule('0 8 * * *', async () => {
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const h = (new Date() - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (h > 48) continue;
    try {
      const quote = await callClaude([{
        role: 'user',
        content: `אתה מקס. ציטוט מוטיבציה בוקר קצר ואנרגטי.
${user.profile.name ? `שם המשתמש: ${user.profile.name}` : ''}
רצף: ${user.streak} ימים.

🌅 בוקר טוב${user.profile.name ? ` ${user.profile.name}` : ''}! [יום בשבוע] מתחיל עכשיו!

💬 "[ציטוט — משפט אחד]"
— [מחבר]

🔥 [משפט אישי ממקס לפי הרצף]

מה התוכנית היום? 💪`
      }], null, 250);
      await sendWhatsApp(userId, quote);
    } catch (e) { console.error('Morning quote error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== CRON: תזכורת חכמה 13:00 ===================
cron.schedule('0 13 * * *', async () => {
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const h = (new Date() - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (h > 24) continue;
    try {
      const reminder = await generateSmartReminder(user, userId);
      if (reminder) await sendWhatsApp(userId, reminder);
    } catch (e) { console.error('Smart reminder error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== CRON: סיכום ערב 20:00 ===================
cron.schedule('0 20 * * *', async () => {
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const h = (new Date() - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (h > 24) continue;
    try {
      const mealCount = user.todayMeals.length;
      const name = user.profile.name || '';
      const msg = `🌙 סיכום יום${name ? ` — ${name}` : ''}!\n\n${mealCount > 0 ? `✅ תיעדת ${mealCount} ארוחות היום` : '⚠️ לא תיעדת ארוחות היום'}\n💧 שתית מספיק מים?\n😴 לך לישון לפני 23:00 לאחזור מיטבי\n🔥 רצף: ${user.streak} ימים\n\nשלח "דוח יומי" לסיכום תזונה מלא 📊`;
      await sendWhatsApp(userId, msg);
    } catch (e) { console.error('Evening summary error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== CRON: אתגר שבועי ראשון 9:30 ===================
cron.schedule('30 9 * * 0', async () => {
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const h = (new Date() - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (h > 72) continue;
    try {
      const challenge = await generateWeeklyChallenge(user);
      user.weeklyChallenge = challenge;
      user.challengeCompleted = false;
      await sendWhatsApp(userId, challenge);
    } catch (e) { console.error('Weekly challenge error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== CRON: מים כל 2 שעות ===================
cron.schedule('0 */2 * * *', async () => {
  const now = new Date();
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const h = (now - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (h > 24) continue;
    const waterGoal = user.profile?.waterGoal || 2500;
    const msgs = [
      `💧 זמן לשתות מים!\nמטרה יומית: ${waterGoal}ml 🙏`,
      `💦 תזכורת מים! מים = אנרגיה = ביצועים 💪`,
      `🌊 שתה מים עכשיו! ${waterGoal}ml ביום 🎯`
    ];
    try { await sendWhatsApp(userId, msgs[Math.floor(Math.random() * msgs.length)]); }
    catch (e) { console.error('Water reminder error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== CRON: תמונת גוף שבועית ראשון 9:00 ===================
cron.schedule('0 9 * * 0', async () => {
  for (const [userId, user] of Object.entries(users)) {
    if (!user.lastActive) continue;
    const h = (new Date() - new Date(user.lastActive)) / (1000 * 60 * 60);
    if (h > 48) continue;
    try {
      await sendWhatsApp(userId,
        `📸 הגיע הזמן לתמונת ההתקדמות השבועית!\n\nשלח תמונה בלי חולצה ואנתח:\n💪 אחוזי שומן\n📊 השוואה לשבוע שעבר\n🎯 המלצות לשיפור 🔥`
      );
    } catch (e) { console.error('Weekly photo error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== MAIN WEBHOOK ===================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message) return;

    console.log('Message from', message.from, '| type:', message.type);

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
      const p = user.profile;
      reply = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `אתה מקס — מאמן כושר. נתח גוף בתמונה.
נתונים: גובה ${p.height || 'לא ידוע'}cm, משקל ${p.weight || 'לא ידוע'}kg, BMI ${p.bmi || 'לא חושב'}
📊 אחוזי שומן: X% | 💪 סוג גוף: X | 🎯 אזורים לשיפור: X | ✅ מה טוב: X | 💡 המלצה: X` }
        ]
      }], null, 800);
      user.pendingMeal = null;

    // =================== תמונת בדיקת דם ===================
    } else if (message.type === 'image' && user.pendingMeal === 'blood_test_photo') {
      const { base64, mimeType } = await downloadImage(message.image.id);
      await sendWhatsApp(userId, `🔬 מנתח את בדיקות הדם שלך... רגע אחד!`);
      const analysis = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `אתה מקס — מנחה בריאות. קרא את ערכי בדיקת הדם מהתמונה ונתח אותם.
פרופיל: גיל ${user.profile.age || 'לא ידוע'}, גובה ${user.profile.height || 'לא ידוע'}cm, משקל ${user.profile.weight || 'לא ידוע'}kg
מחלות: ${user.medicalHistory.conditions.join(', ') || 'אין'} | תרופות: ${user.medicalHistory.medications.join(', ') || 'אין'}

נתח לפי: ✅ תקין | ⚠️ גבולי | 🚨 חריג | 💊 חוסרים | 📈 עודפים | 🔗 שילובים חשודים | 🥗 המלצות תזונה
⚕️ סיים עם תזכורת להתייעץ עם רופא` }
        ]
      }], null, 1500);
      user.medicalHistory.lastBloodTest = new Date().toISOString();
      user.medicalHistory.bloodTests.push({ date: new Date().toISOString(), analysis: analysis.substring(0, 200) });
      user.pendingMeal = null;
      reply = analysis;

    // =================== תמונת אוכל ===================
    } else if (message.type === 'image') {
      const { base64, mimeType } = await downloadImage(message.image.id);
      const fullReply = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `אתה מקס — מאמן תזונה. נתח אוכל בתמונה. אם יש יד — השתמש כקנה מידה.

🍽️ מה אני רואה: X | 📏 קנה מידה: X
🔥 קלוריות: ~X | 💪 חלבון: Xg | 🍞 פחמימות: Xg | 🍬 סוכרים: Xg | 🥑 שומן: Xg
🧂 ברזל: Xmg | סידן: Xmg | אשלגן: Xmg | מגנזיום: Xmg | ויטמין C: Xmg | D: Xμg | B12: Xμg
💡 טיפ: X
❓ מדויק? לתקן — כתוב לי. בסדר — כתוב "שמור"

DATA:{"calories":X,"protein":X,"carbs":X,"fat":X,"sugar":X,"minerals":{"iron":X,"calcium":X,"potassium":X,"magnesium":X,"sodium":X,"zinc":X,"vitC":X,"vitD":X,"vitB12":X}}` }
        ]
      }], null, 1000);

      const dataMatch = fullReply.match(/DATA:(\{.*?\})/s);
      if (dataMatch) {
        try { user.pendingMeal = { data: JSON.parse(dataMatch[1]), time: new Date().toLocaleTimeString('he-IL') }; }
        catch (e) { console.error('Meal parse error:', e.message); }
      }
      reply = fullReply.replace(/DATA:\{.*?\}/s, '').trim();

    // =================== טקסט ===================
    } else if (message.type === 'text') {
      const userMsg = message.text.body.trim();
      console.log('Text:', userMsg.substring(0, 80));

      // ===== שמירת ארוחה =====
      if (userMsg === 'שמור' || userMsg.toLowerCase() === 'save') {
        if (user.pendingMeal && user.pendingMeal.data) {
          user.todayMeals.push(user.pendingMeal);
          user.pendingMeal = null;
          reply = `✅ נשמר! ${user.todayMeals.length} ארוחות היום.\nשלח "דוח יומי" לסיכום 📊`;
        } else {
          reply = `אין ארוחה ממתינה 😅`;
        }

      // ===== היסטוריה רפואית =====
      } else if (userMsg.includes('בריא לחלוטין') || userMsg.includes('אין מחלות')) {
        user.medicalHistory.medicalAsked = true;
        reply = `✅ מעולה! רשמתי שאתה בריא לחלוטין.\nעכשיו אני יכול לתת לך המלצות ללא מגבלות 💪\n\nמה נעבוד עליו היום?`;

      } else if (
        user.medicalHistory.medicalAsked === false &&
        user.history.length >= 8 &&
        !userMsg.includes('אתגר') &&
        !userMsg.includes('תוכנית')
      ) {
        // שואלים היסטוריה רפואית אחרי מספיק שיחה
        user.medicalHistory.medicalAsked = true;
        reply = getMedicalHistoryQuestion();

      // ===== ניתוח בדיקת דם (טקסט) =====
      } else if (
        userMsg.includes('בדיקת דם') ||
        userMsg.includes('תוצאות בדיקה') ||
        userMsg.includes('ניתוח בדיקה')
      ) {
        // בודק אם זה טקסט עם ערכים או בקשה לשלוח תמונה
        if (userMsg.length > 50) {
          // יש ערכים בטקסט — נתח
          await sendWhatsApp(userId, `🔬 מנתח את הבדיקות... רגע!`);
          const analysis = await analyzeBloodTest(userMsg, user.profile, user.medicalHistory);
          user.medicalHistory.lastBloodTest = new Date().toISOString();
          reply = analysis;
        } else {
          // בקשה כללית — שאל איך לשלוח
          user.pendingMeal = 'blood_test_photo';
          reply = `🔬 מעולה! יש 2 אפשרויות:\n\n1️⃣ שלח **תמונה** של הדף עם תוצאות הבדיקה\n2️⃣ **הקלד** את הערכים בפורמט:\nהמוגלובין: 14.2\nויטמין D: 18\nB12: 320\n...וכו׳\n\nאנתח הכל ואגיד לך מה מצוין, מה גבולי ומה דורש תשומת לב 🎯`;
        }

      // ===== יוטיוב כושר =====
      } else if (
        userMsg.includes('סרטון') ||
        userMsg.includes('יוטיוב') ||
        userMsg.includes('youtube') ||
        userMsg.includes('להראות לי')
      ) {
        const isHealth = ['ויטמין', 'הורמון', 'ביוהאקינג', 'שינה', 'לחץ', 'אינסולין'].some(w => userMsg.includes(w));
        const topic = userMsg.replace(/סרטון|יוטיוב|youtube|על|של|להראות לי/gi, '').trim() || 'כושר כללי';
        reply = await getYouTubeRecommendations(topic, isHealth ? 'health' : 'exercise');

      // ===== בקשת המלצת יוטיוב לתרגיל ספציפי =====
      } else if (
        userMsg.includes('איך עושים') ||
        userMsg.includes('תרגיל ל') ||
        userMsg.includes('איך מתאמן')
      ) {
        const topic = userMsg.replace(/איך עושים|תרגיל ל|איך מתאמן/gi, '').trim();
        reply = await getYouTubeRecommendations(topic, 'exercise');

      // ===== השלמת אתגר =====
      } else if (userMsg.includes('השלמתי אתגר') || userMsg.includes('סיימתי אתגר')) {
        if (user.weeklyChallenge && !user.challengeCompleted) {
          user.challengeCompleted = true;
          user.streak += 1;
          reply = await callClaude([{
            role: 'user',
            content: `מקס חוגג! המשתמש${user.profile.name ? ` ${user.profile.name}` : ''} השלים אתגר שבועי! רצף: ${user.streak} ימים.
🎉 חגיגה גדולה + 🏆 רצף + ⭐ אתגר בונוס קטן. קצר ואנרגטי!`
          }], null, 300);
        } else if (user.challengeCompleted) {
          reply = `כבר השלמת השבוע — אתה אלוף! 🏆\nהאתגר הבא — ביום ראשון 💪`;
        } else {
          reply = `עדיין אין לך אתגר שבועי 😅\nשלח "אתגר שבועי" ואייצר לך אחד!`;
        }

      // ===== אתגר שבועי =====
      } else if (userMsg.includes('אתגר שבועי') || userMsg.includes('אתגר')) {
        const challenge = await generateWeeklyChallenge(user);
        user.weeklyChallenge = challenge;
        user.challengeCompleted = false;
        reply = challenge;

      // ===== תוכנית אימונים =====
      } else if (
        userMsg.includes('תוכנית אימונים') ||
        userMsg.includes('תוכנית כושר') ||
        userMsg.includes('אימון שבועי')
      ) {
        await sendWhatsApp(userId, `💪 בונה תוכנית אימונים מותאמת אישית... 🔥`);
        user.workoutPlan = await generateWorkoutPlan(user);
        reply = user.workoutPlan;

      // ===== ציטוט מוטיבציה =====
      } else if (userMsg.includes('ציטוט') || userMsg.includes('מוטיבציה')) {
        reply = await callClaude([{
          role: 'user',
          content: `מקס. ציטוט מוטיבציה קצר. רצף: ${user.streak} ימים.\n💬 "[ציטוט]"\n— [מחבר]\n🔥 [משפט ממקס]`
        }], null, 200);

      // ===== דוח יומי =====
      } else if (userMsg.includes('דוח יומי') || userMsg.toLowerCase().includes('daily report')) {
        const report = generateDailyReport(user.todayMeals);
        if (!report || report.mealCount === 0) {
          reply = `😅 עוד לא שלחת תמונות אוכל היום.\nשלח תמונה של הארוחה הבאה! 📸`;
        } else {
          reply = await callClaude([{
            role: 'user',
            content: `מקס. דוח יומי מעודד:
${report.mealCount} ארוחות | ${report.totalCalories} קק"ל | חלבון: ${report.totalProtein}g | פחמימות: ${report.totalCarbs}g | שומן: ${report.totalFat}g | סוכר: ${report.totalSugar}g
מים: ${user.profile?.waterGoal || 2500}ml | מינרלים: ${Object.entries(report.minerals).map(([k,v]) => `${k}:${v}`).join(', ')}
סיכום + מה טוב + מה חסר + המלצות + ציון מ-10. קצר ומעודד!`
          }], null, 800);
        }

      // ===== תמונת גוף =====
      } else if (userMsg.includes('תמונת גוף') || userMsg.includes('אחוזי שומן')) {
        user.pendingMeal = 'body_photo';
        reply = `💪 שלח תמונה בלי חולצה ואנתח:\n- אחוזי שומן\n- סוג גוף\n- המלצות אישיות\nאור טוב ותמונה ברורה! 📸`;

      // ===== תיקון ארוחה =====
      } else if (user.pendingMeal && user.pendingMeal.data) {
        const corrReply = await callClaude([{
          role: 'user',
          content: `מקס. תקן נתוני ארוחה.
נתונים: ${JSON.stringify(user.pendingMeal.data)}
תיקון: "${userMsg}"
תן תשובה + DATA:{"calories":X,"protein":X,"carbs":X,"fat":X,"sugar":X,"minerals":{"iron":X,"calcium":X,"potassium":X,"magnesium":X,"sodium":X,"zinc":X,"vitC":X,"vitD":X,"vitB12":X}}`
        }], null, 600);
        const dataMatch = corrReply.match(/DATA:(\{.*?\})/s);
        if (dataMatch) {
          try { user.pendingMeal.data = JSON.parse(dataMatch[1]); } catch (e) {}
        }
        reply = corrReply.replace(/DATA:\{.*?\}/s, '').trim();

      // ===== שיחה רגילה =====
      } else {
        user.history.push({ role: 'user', content: userMsg });
        if (user.history.length > 30) user.history = user.history.slice(-30);

        const systemWithState = MAX_PERSONALITY + `\n\n📊 מצב:
- שם: ${user.profile.name || 'לא ידוע'} | גיל: ${user.profile.age || 'לא ידוע'}
- רצף: ${user.streak} ימים | יום היכרות: ${user.onboardingDay}
- גובה: ${user.profile.height || '?'} | משקל: ${user.profile.weight || '?'} | BMI: ${user.profile.bmi || '?'}
- מים: ${user.profile.waterGoal || '?'}ml | ארוחות היום: ${user.todayMeals.length}
- מחלות: ${user.medicalHistory.conditions.join(', ') || 'אין'} | תרופות: ${user.medicalHistory.medications.join(', ') || 'אין'}
- היסטוריה רפואית נשאלה: ${user.medicalHistory.medicalAsked}
- אתגר פעיל: ${user.weeklyChallenge ? 'כן' : 'לא'} | הושלם: ${user.challengeCompleted}`;

        let aiReply = await callClaude(user.history, systemWithState, 1000);

        // שמירת BMI
        const bmiMatch = aiReply.match(/\[SAVE_BMI:(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]/);
        if (bmiMatch) {
          const height = parseFloat(bmiMatch[1]);
          const weight = parseFloat(bmiMatch[2]);
          const { bmi, status, waterGoal } = calculateBMI(height, weight);
          user.profile = { ...user.profile, height, weight, bmi, waterGoal };
          aiReply = aiReply.replace(bmiMatch[0], '').trim();
          aiReply += `\n\n📊 BMI: ${bmi} (${status})\n💧 מים ביום: ${waterGoal}ml`;
        }

        // שמירת שם
        const nameMatch = aiReply.match(/\[SAVE_NAME:([^\]]+)\]/);
        if (nameMatch) {
          user.profile.name = nameMatch[1].trim();
          aiReply = aiReply.replace(nameMatch[0], '').trim();
        }

        // שמירת גיל
        const ageMatch = aiReply.match(/\[SAVE_AGE:(\d+)\]/);
        if (ageMatch) {
          user.profile.age = parseInt(ageMatch[1]);
          aiReply = aiReply.replace(ageMatch[0], '').trim();
        }

        // רישום מידע רפואי מהשיחה
        if (userMsg.match(/לוקח|אני עם|יש לי|סובל מ|אלרגי/)) {
          user.medicalHistory.medicalAsked = true;
        }

        // הוספת רמז יכולת חדשה
        const capHint = getCapabilityHint(userMsg, user);
        if (capHint) aiReply += capHint;

        reply = aiReply;
        user.history.push({ role: 'assistant', content: reply });

        if (user.onboardingDay < 3 && user.history.length > 6) {
          user.onboardingDay = Math.min(3, Math.floor(user.history.length / 6) + 1);
        }
      }

    } else {
      reply = `סוג הודעה לא נתמך 😅 שלח טקסט או תמונה!`;
    }

    if (reply) await sendWhatsApp(userId, reply);

  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message);
  }
});

app.get('/', (req, res) => res.send('מקס פועל! 🚀'));

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 מקס פועל על פורט', process.env.PORT || 3000);
  console.log('PHONE_NUMBER_ID:', PHONE_NUMBER_ID);
  console.log('WA_TOKEN set:', !!WA_TOKEN);
  console.log('ANTHROPIC_API_KEY set:', !!ANTHROPIC_API_KEY);
});
