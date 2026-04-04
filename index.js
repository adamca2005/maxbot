const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const VERIFY_TOKEN = 'maxbot123';

let usersCollection;
const memoryCache = {};

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db('maxbot');
    usersCollection = db.collection('users');
    await usersCollection.createIndex({ userId: 1 }, { unique: true });
    console.log('MongoDB connected!');
  } catch (err) {
    console.error('MongoDB error:', err.message);
  }
}

async function getUser(userId) {
  if (memoryCache[userId]) return memoryCache[userId];
  if (usersCollection) {
    try {
      const doc = await usersCollection.findOne({ userId });
      if (doc) {
        delete doc._id;
        // נקה timestamp מהיסטוריה ישנה
        if (doc.history) {
          doc.history = doc.history.map(m => ({ role: m.role, content: m.content }));
        }
        memoryCache[userId] = doc;
        return doc;
      }
    } catch (err) { console.error('getUser error:', err.message); }
  }
  const newUser = {
    userId, createdAt: new Date(), history: [], summaryHistory: [],
    onboardingDay: 1, streak: 0, lastCheckIn: null, todayMeals: [],
    pendingMeal: null,
    profile: { height: null, weight: null, bmi: null, waterGoal: null, age: null, name: null, goals: [] },
    medicalHistory: { conditions: [], medications: [], allergies: [], bloodTests: [], lastBloodTest: null, medicalAsked: false },
    fitnessData: { todaySteps: 0, todayWorkoutMinutes: 0, todayWorkoutType: null, weeklySteps: [], weeklyWorkouts: [], stepGoal: 8000 },
    lastActive: null, waterReminders: 0, weeklyChallenge: null, challengeCompleted: false,
    workoutPlan: null, shownCapabilities: [],
    proactive: { lastRandomMessage: null, randomMessageCount: 0 }
  };
  memoryCache[userId] = newUser;
  await saveUser(newUser);
  return newUser;
}

async function saveUser(user) {
  // נקה timestamp לפני שמירה
  if (user.history) {
    user.history = user.history.map(m => ({ role: m.role, content: m.content }));
  }
  memoryCache[user.userId] = user;
  if (!usersCollection) return;
  try {
    await usersCollection.replaceOne({ userId: user.userId }, { ...user, updatedAt: new Date() }, { upsert: true });
  } catch (err) { console.error('saveUser error:', err.message); }
}

async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  // תמיד נקה — שלח רק role ו-content
  const clean = messages.map(m => ({ role: m.role, content: m.content }));
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages: clean };
  if (systemPrompt) body.system = systemPrompt;
  const res = await axios.post('https://api.anthropic.com/v1/messages', body, {
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  });
  return res.data.content[0].text;
}

async function addToHistory(user, role, content) {
  // שמור רק role ו-content — ללא timestamp!
  user.history.push({ role, content });
  if (user.history.length > 40) {
    const toSummarize = user.history.splice(0, 20);
    try {
      const text = toSummarize.map(m => `${m.role === 'user' ? 'משתמש' : 'מקס'}: ${m.content}`).join('\n');
      const summary = await callClaude([{ role: 'user', content: `סכם ב-5 משפטים קצרים. שמור: מטרות, בעיות, הישגים. גוף שלישי.\n\n${text}` }], null, 300);
      user.summaryHistory.push({ summary, date: new Date() });
      if (user.summaryHistory.length > 10) user.summaryHistory = user.summaryHistory.slice(-10);
    } catch (e) { console.error('Summary error:', e.message); }
  }
}

function buildContext(user) {
  const summaryText = user.summaryHistory?.length > 0
    ? '📚 היסטוריה:\n' + user.summaryHistory.map(s => `[${new Date(s.date).toLocaleDateString('he-IL')}]: ${s.summary}`).join('\n')
    : '';
  // חשוב מאוד: רק role ו-content!
  const recentHistory = (user.history || []).slice(-30).map(m => ({ role: m.role, content: m.content }));
  return { summaryText, recentHistory };
}

async function sendWhatsApp(userId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: userId, type: 'text', text: { body: text } },
      { headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('Sent to', userId);
  } catch (err) { console.error('sendWhatsApp error:', err.response?.data || err.message); throw err; }
}

async function downloadMedia(mediaId) {
  const mediaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  const fileRes = await axios.get(mediaRes.data.url, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  return { base64: Buffer.from(fileRes.data).toString('base64'), mimeType: mediaRes.data.mime_type || 'image/jpeg' };
}

function calculateBMI(h, w) {
  const bmi = (w / ((h / 100) ** 2)).toFixed(1);
  const status = bmi < 18.5 ? 'תת משקל' : bmi < 25 ? 'משקל תקין ✅' : bmi < 30 ? 'עודף משקל' : 'השמנה';
  return { bmi, status, waterGoal: Math.round(w * 35) };
}

function buildDailyReport(meals) {
  if (!meals?.length) return null;
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0 };
  const minerals = {};
  for (const meal of meals) {
    const d = meal.data || meal;
    for (const k of Object.keys(totals)) totals[k] += d[k] || 0;
    if (d.minerals) for (const [k, v] of Object.entries(d.minerals)) minerals[k] = (minerals[k] || 0) + v;
  }
  return { ...totals, minerals, mealCount: meals.length };
}

function parseFitness(msg, user) {
  const steps = msg.match(/(\d[\d,]*)\s*(?:צעדים|steps)/i);
  const workout = msg.match(/(?:אימון|ריצה|הליכה|gym|חדר כושר|יוגה|שחייה|אופניים)[^\d]*(\d+)?\s*(?:דק|דקות|min|שעה)?/i);
  let updated = false;
  if (steps) { user.fitnessData.todaySteps = parseInt(steps[1].replace(',', '')); updated = true; }
  if (workout) { user.fitnessData.todayWorkoutMinutes += workout[1] ? parseInt(workout[1]) : 45; updated = true; }
  return updated;
}

function fitnessBar(user) {
  const fd = user.fitnessData;
  const goal = fd.stepGoal || 8000;
  const pct = Math.min(100, Math.round((fd.todaySteps / goal) * 100));
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  return `📊 כושר:\n👟 ${fd.todaySteps.toLocaleString()}/${goal.toLocaleString()} [${bar}] ${pct}%\n💪 אימון: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} דקות` : 'לא דווח'}`;
}

async function searchYouTube(query) {
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: query, type: 'video', maxResults: 1, key: YOUTUBE_API_KEY }
    });
    const item = res.data.items[0];
    if (!item) return null;
    return { title: item.snippet.title, channel: item.snippet.channelTitle, url: `https://www.youtube.com/watch?v=${item.id.videoId}` };
  } catch (err) { return null; }
}

async function getYouTubeRecommendations(topic, type) {
  const queriesText = await callClaude([{ role: 'user', content: `3 שאילתות חיפוש ביוטיוב ל"${topic}". שורה לכל אחת. ללא מספרים.` }], null, 100);
  const queries = queriesText.trim().split('\n').filter(q => q.trim()).slice(0, 3);
  let msg = `${type === 'health' ? '🎓' : '🎬'} סרטונים ביוטיוב על "${topic}":\n\n`;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i].trim();
    const emoji = ['1️⃣', '2️⃣', '3️⃣'][i];
    const video = await searchYouTube(q);
    if (video) {
      msg += `${emoji} *${video.title}*\n   📺 ${video.channel}\n   🔗 ${video.url}\n\n`;
    } else {
      msg += `${emoji} ${q}\n   🔗 https://www.youtube.com/results?search_query=${encodeURIComponent(q)}\n\n`;
    }
  }
  return msg.trim();
}

async function generateChallenge(user) {
  return await callClaude([{ role: 'user', content: `מקס. אתגר שבועי מותאם. ${user.profile.height || '?'}cm, ${user.profile.weight || '?'}kg, רצף ${user.streak}. 🏆 שם | 📋 משימה | 🎯 הצלחה | 💡 טיפ. "השלמתי אתגר" בסיום 🎉` }], null, 350);
}

async function generateWorkoutPlan(user) {
  return await callClaude([{ role: 'user', content: `מקס. תוכנית אימונים 7 ימים. ${user.profile.height || '?'}cm | ${user.profile.weight || '?'}kg | גיל ${user.profile.age || '?'} | מגבלות: ${user.medicalHistory?.conditions?.join(', ') || 'אין'}. תרגילים + סטים + מנוחה. ⏱️ זמן | 💡 טיפ.` }], null, 1200);
}

function capabilityHint(msg, user) {
  const shown = user.shownCapabilities || [];
  const m = msg.toLowerCase();
  const caps = [
    { id: 'blood_test', triggers: ['עייפות', 'עייף', 'חלש', 'אנרגיה', 'שיער'], hint: `\n\n🔬 אגב — אני יכול לנתח בדיקות דם ולזהות חוסרים!` },
    { id: 'youtube', triggers: ['תרגיל', 'אימון', 'כושר', 'ויטמין'], hint: `\n\n🎬 אגב — אני יכול לשלוח סרטוני יוטיוב אמיתיים!` },
    { id: 'food_photo', triggers: ['אכלתי', 'ארוחה', 'קלוריות'], hint: `\n\n📸 אגב — שלח תמונת אוכל ואנתח קלוריות ומינרלים!` },
    { id: 'memory', triggers: ['שכחתי', 'דיברנו', 'אמרתי'], hint: `\n\n🧠 אגב — אני זוכר את כל השיחות שלנו לצמיתות!` }
  ];
  for (const cap of caps) {
    if (!shown.includes(cap.id) && cap.triggers.some(t => m.includes(t))) {
      user.shownCapabilities.push(cap.id);
      return cap.hint;
    }
  }
  return '';
}

async function getActiveUsers(hoursAgo) {
  if (usersCollection) {
    try { return await usersCollection.find({ lastActive: { $gt: new Date(Date.now() - hoursAgo * 3600000) } }).toArray(); }
    catch (e) { return Object.values(memoryCache); }
  }
  return Object.values(memoryCache).filter(u => u.lastActive && (Date.now() - new Date(u.lastActive)) / 3600000 < hoursAgo);
}

const MAX_PERSONALITY = `אתה "מקס" — מאמן חיים אישי בוויצאפ. חוצפן, ישיר, מצחיק, מלא אנרגיה. מדבר עברית או אנגלית לפי המשתמש. חם — מברך עם "היי"/"היייי" ולא "יו יו יו".
🎯 המשימה: תזונה, כושר, שינה, ביוהאקינג. מנחה — לא מחליף רופא.
📋 היכרות: יום1: שם,גיל,מטרות,גובה,משקל | יום2: תזונה,שינה,כושר | יום3: מכשולים,זמן
📌 גובה+משקל → [SAVE_BMI:גובה:משקל] | שם → [SAVE_NAME:שם] | גיל → [SAVE_AGE:גיל]
🧠 השתמש בהיסטוריה! התייחס לדברים מהעבר.
💪 סגנון: עד 5 שורות, אמוג'י, שאלה אחת בסוף. ראשונה — ברכה + שם!`;

cron.schedule('0 8 * * *', async () => {
  const users = await getActiveUsers(48);
  for (const user of users) {
    try {
      const q = await callClaude([{ role: 'user', content: `מקס. ציטוט בוקר.${user.profile?.name ? ` שם: ${user.profile.name}.` : ''} רצף: ${user.streak || 0}.\n🌅 בוקר טוב! 💬 "[ציטוט]" — [מחבר] 🔥 [ממקס]. מה התוכנית? 💪` }], null, 150);
      await sendWhatsApp(user.userId, q);
    } catch (e) { console.error('Morning quote error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 13 * * *', async () => {
  const users = await getActiveUsers(24);
  for (const user of users) {
    try {
      const msg = `⚡ עדכון צהריים!\n${user.todayMeals?.length > 0 ? `🍽️ ${user.todayMeals.length} ארוחות` : '📸 עוד לא תיעדת!'}\n${user.fitnessData?.todaySteps > 0 ? `👟 ${user.fitnessData.todaySteps.toLocaleString()} צעדים` : '👟 דווח על צעדים!'}\n💧 שתית מים? 💪`;
      await sendWhatsApp(user.userId, msg);
    } catch (e) { console.error('Midday error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 20 * * *', async () => {
  const users = await getActiveUsers(24);
  for (const user of users) {
    try {
      const fd = user.fitnessData || {};
      const goal = fd.stepGoal || 8000;
      const icon = (fd.todaySteps || 0) >= goal ? '✅' : (fd.todaySteps || 0) > 0 ? '⚡' : '❌';
      const msg = `🌙 סיכום יום!\n${icon} צעדים: ${(fd.todaySteps || 0).toLocaleString()}/${goal.toLocaleString()}\n💪 אימון: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} דקות` : 'לא דווח'}\n🍽️ ארוחות: ${user.todayMeals?.length || 0} | 🔥 רצף: ${user.streak || 0}\n😴 שינה לפני 23:00! שלח "דוח יומי" 📊`;
      await sendWhatsApp(user.userId, msg);
    } catch (e) { console.error('Evening error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

for (const hour of [10, 15, 18]) {
  cron.schedule(`0 ${hour} * * *`, async () => {
    if (Math.random() > 0.5) return;
    const users = await getActiveUsers(48);
    for (const user of users) {
      if (user.proactive?.lastRandomMessage && (Date.now() - new Date(user.proactive.lastRandomMessage)) / 3600000 < 4) continue;
      try {
        const types = [
          () => callClaude([{ role: 'user', content: `מקס. רעיון ביוהאקינג מפתיע קצר. 💡 [רעיון]. 3 שורות + שאלה.` }], null, 120),
          () => callClaude([{ role: 'user', content: `מקס. עובדה מדעית מפתיעה על הגוף. 🧠 [עובדה]. "ידעת?" 2 שורות.` }], null, 100),
          () => callClaude([{ role: 'user', content: `מקס. הודעה אישית ספונטנית${user.profile?.name ? ` ל${user.profile.name}` : ''}. רצף: ${user.streak}. כאילו עלה לך רעיון — חם, 3 שורות + שאלה.` }], null, 120),
        ];
        const msg = await types[Math.floor(Math.random() * types.length)]();
        await sendWhatsApp(user.userId, msg);
        if (!user.proactive) user.proactive = {};
        user.proactive.lastRandomMessage = new Date();
        await saveUser(user);
      } catch (e) { console.error('Proactive error:', e.message); }
    }
  }, { timezone: 'Asia/Jerusalem' });
}

cron.schedule('30 9 * * 0', async () => {
  const users = await getActiveUsers(72);
  for (const user of users) {
    try {
      const ch = await generateChallenge(user);
      user.weeklyChallenge = ch; user.challengeCompleted = false;
      await saveUser(user);
      await sendWhatsApp(user.userId, ch);
    } catch (e) { console.error('Challenge error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 */2 * * *', async () => {
  const h = new Date().getHours();
  if (h < 8 || h > 22) return;
  const users = await getActiveUsers(24);
  for (const user of users) {
    const goal = user.profile?.waterGoal || 2500;
    const msgs = [`💧 זמן לשתות! מטרה: ${goal}ml 🙏`, `💦 מים = אנרגיה! 💪`, `🌊 שתה עכשיו! ${goal}ml ביום 🎯`];
    try { await sendWhatsApp(user.userId, msgs[Math.floor(Math.random() * msgs.length)]); }
    catch (e) { console.error('Water error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses) return;
    const message = value?.messages?.[0];
    if (!message) return;

    console.log('MSG from', message.from, '| type:', message.type);
    const userId = message.from;
    const user = await getUser(userId);
    user.lastActive = new Date();

    const today = new Date().toDateString();
    if (user.lastCheckIn !== today) {
      user.streak = (user.streak || 0) + 1;
      user.lastCheckIn = today;
      user.todayMeals = [];
      user.waterReminders = 0;
      if (user.fitnessData) { user.fitnessData.todaySteps = 0; user.fitnessData.todayWorkoutMinutes = 0; }
    }

    let reply = '';

    if (message.type === 'audio') {
      reply = `🎤 קיבלתי הודעה קולית! כתוב לי בטקסט ואענה מיד 💪`;

    } else if (message.type === 'image' && user.pendingMeal === 'body_photo') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      reply = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `מקס. נתח גוף. ${user.profile.height || '?'}cm, ${user.profile.weight || '?'}kg. 📊 אחוזי שומן | 💪 סוג גוף | 🎯 לשיפור | ✅ טוב | 💡 המלצה.` }
      ]}], null, 600);
      user.pendingMeal = null;

    } else if (message.type === 'image' && user.pendingMeal === 'blood_test_photo') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      await sendWhatsApp(userId, `🔬 מנתח בדיקות דם... רגע!`);
      reply = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `מקס. נתח בדיקות דם. ✅ תקין | ⚠️ גבולי | 🚨 חריג | 💊 חוסרים | 📈 עודפים | 🥗 המלצות | ⚕️ הפנה לרופא` }
      ]}], null, 1400);
      user.pendingMeal = null;

    } else if (message.type === 'image') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      const full = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `מקס — תזונה. נתח אוכל. יד = קנה מידה. 🍽️ מה | 🔥 קלוריות | 💪 חלבון | 🍞 פחמימות | 🍬 סוכרים | 🥑 שומן | 🧂 מינרלים | 💡 טיפ | ❓ מדויק? תקן או "שמור"
DATA:{"calories":0,"protein":0,"carbs":0,"fat":0,"sugar":0,"minerals":{"iron":0,"calcium":0,"potassium":0,"magnesium":0,"sodium":0,"zinc":0,"vitC":0,"vitD":0,"vitB12":0}}` }
      ]}], null, 900);
      const dm = full.match(/DATA:(\{.*?\})/s);
      if (dm) { try { user.pendingMeal = { data: JSON.parse(dm[1]), time: new Date().toLocaleTimeString('he-IL') }; } catch (e) {} }
      reply = full.replace(/DATA:\{.*?\}/s, '').trim();

    } else if (message.type === 'text') {
      const msg = message.text.body.trim();
      const fitnessUpdated = parseFitness(msg, user);

      if (msg === 'שמור' || msg.toLowerCase() === 'save') {
        if (user.pendingMeal?.data) {
          user.todayMeals.push(user.pendingMeal); user.pendingMeal = null;
          reply = `✅ נשמר! ${user.todayMeals.length} ארוחות היום 📊`;
        } else { reply = `אין ארוחה ממתינה 😅`; }

      } else if (msg.includes('כושר שלי') || msg.includes('סטטוס')) {
        reply = fitnessBar(user) + `\n\n💡 דווח: "עשיתי 8,000 צעדים" / "אימון 45 דקות"`;

      } else if (fitnessUpdated) {
        reply = await callClaude([{ role: 'user', content: `מקס. תגיב לדיווח כושר. צעדים: ${user.fitnessData.todaySteps}, אימון: ${user.fitnessData.todayWorkoutMinutes} דקות. קצר + מעודד + שאלה.` }], null, 150);

      } else if (msg.includes('בריא לחלוטין') || msg.includes('אין מחלות')) {
        user.medicalHistory.medicalAsked = true;
        reply = `✅ מושלם! בריא לחלוטין 💪\nבלי מגבלות — נתחיל! מה המטרה הראשונה? 🔥`;

      } else if (!user.medicalHistory.medicalAsked && user.history.length >= 8) {
        user.medicalHistory.medicalAsked = true;
        reply = `🏥 שאלה חשובה:\n1. מחלות כרוניות?\n2. תרופות?\n3. אלרגיות?\n\nכתוב הכל 🔒 | אין? "בריא לחלוטין"\n⚠️ אני מנחה — לא רופא`;

      } else if (msg.includes('בדיקת דם') || msg.includes('תוצאות בדיקה')) {
        if (msg.length > 60) {
          await sendWhatsApp(userId, `🔬 מנתח... רגע!`);
          reply = await callClaude([{ role: 'user', content: `מקס. נתח בדיקת דם:\n${msg}\n✅ תקין | ⚠️ גבולי | 🚨 חריג | 💊 חוסרים | 🥗 המלצות | ⚕️ הפנה לרופא` }], null, 1200);
        } else {
          user.pendingMeal = 'blood_test_photo';
          reply = `🔬 2 אפשרויות:\n1️⃣ שלח תמונה של הבדיקה\n2️⃣ הקלד ערכים:\nויטמין D: 18\nB12: 320`;
        }

      } else if (msg.includes('סרטון') || msg.includes('יוטיוב') || msg.toLowerCase().includes('youtube') || msg.includes('איך עושים') || msg.includes('תרגיל ל')) {
        const isHealth = ['ויטמין', 'הורמון', 'שינה', 'אינסולין'].some(w => msg.includes(w));
        const topic = msg.replace(/סרטון|יוטיוב|youtube|על|של|איך עושים|תרגיל ל/gi, '').trim() || 'כושר';
        await sendWhatsApp(userId, `🔍 מחפש ביוטיוב...`);
        reply = await getYouTubeRecommendations(topic, isHealth ? 'health' : 'exercise');

      } else if (msg.includes('השלמתי אתגר') || msg.includes('סיימתי אתגר')) {
        if (user.weeklyChallenge && !user.challengeCompleted) {
          user.challengeCompleted = true; user.streak += 1;
          reply = await callClaude([{ role: 'user', content: `מקס חוגג! ${user.profile?.name || ''} השלים אתגר! רצף: ${user.streak}. 🎉🏆⭐ קצר!` }], null, 180);
        } else {
          reply = user.challengeCompleted ? `כבר השלמת — אלוף! 🏆` : `אין אתגר עדיין 😅 שלח "אתגר שבועי"!`;
        }

      } else if (msg.includes('אתגר שבועי') || (msg.includes('אתגר') && !msg.includes('השלמתי'))) {
        const ch = await generateChallenge(user); user.weeklyChallenge = ch; user.challengeCompleted = false; reply = ch;

      } else if (msg.includes('תוכנית אימונים') || msg.includes('תוכנית כושר') || msg.includes('אימון שבועי')) {
        await sendWhatsApp(userId, `💪 בונה תוכנית... 🔥`);
        user.workoutPlan = await generateWorkoutPlan(user); reply = user.workoutPlan;

      } else if (msg.includes('ציטוט') || msg.includes('מוטיבציה')) {
        reply = await callClaude([{ role: 'user', content: `מקס. ציטוט מוטיבציה. רצף: ${user.streak}. 💬 "[ציטוט]" — [מחבר] 🔥 [ממקס].` }], null, 120);

      } else if (msg.includes('דוח יומי') || msg.toLowerCase().includes('daily report')) {
        const report = buildDailyReport(user.todayMeals);
        if (!report) {
          reply = `😅 עוד לא שלחת תמונות אוכל.\n${fitnessBar(user)}\nשלח תמונת אוכל! 📸`;
        } else {
          reply = await callClaude([{ role: 'user', content: `מקס. דוח יומי: ${report.mealCount} ארוחות | ${report.calories}kcal | חלבון: ${report.protein}g | פחמימות: ${report.carbs}g | שומן: ${report.fat}g. ${user.fitnessData.todaySteps} צעדים. סיכום + טוב + חסר + ציון/10. קצר!` }], null, 500);
        }

      } else if (msg.includes('תמונת גוף') || msg.includes('אחוזי שומן')) {
        user.pendingMeal = 'body_photo'; reply = `💪 שלח תמונה בלי חולצה! 📸`;

      } else if (user.pendingMeal?.data) {
        const cr = await callClaude([{ role: 'user', content: `מקס. תקן ארוחה: ${JSON.stringify(user.pendingMeal.data)}. תיקון: "${msg}". תשובה + DATA:{...}` }], null, 400);
        const dm = cr.match(/DATA:(\{.*?\})/s);
        if (dm) { try { user.pendingMeal.data = JSON.parse(dm[1]); } catch (e) {} }
        reply = cr.replace(/DATA:\{.*?\}/s, '').trim();

      } else {
        await addToHistory(user, 'user', msg);
        const { summaryText, recentHistory } = buildContext(user);

        const system = MAX_PERSONALITY + `\n\n${summaryText ? summaryText + '\n\n' : ''}📊 מצב:
שם: ${user.profile?.name || '?'} | גיל: ${user.profile?.age || '?'} | רצף: ${user.streak}
גובה: ${user.profile?.height || '?'} | משקל: ${user.profile?.weight || '?'} | BMI: ${user.profile?.bmi || '?'}
ארוחות: ${user.todayMeals?.length || 0} | צעדים: ${user.fitnessData?.todaySteps || 0}
מחלות: ${user.medicalHistory?.conditions?.join(', ') || 'אין'}`;

        let aiReply = await callClaude(recentHistory, system, 1000);

        const bmiM = aiReply.match(/\[SAVE_BMI:(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]/);
        if (bmiM) {
          const { bmi, status, waterGoal } = calculateBMI(parseFloat(bmiM[1]), parseFloat(bmiM[2]));
          user.profile = { ...user.profile, height: parseFloat(bmiM[1]), weight: parseFloat(bmiM[2]), bmi, waterGoal };
          aiReply = aiReply.replace(bmiM[0], '').trim() + `\n\n📊 BMI: ${bmi} (${status}) | 💧 ${waterGoal}ml/יום`;
        }
        const nameM = aiReply.match(/\[SAVE_NAME:([^\]]+)\]/);
        if (nameM) { user.profile.name = nameM[1].trim(); aiReply = aiReply.replace(nameM[0], '').trim(); }
        const ageM = aiReply.match(/\[SAVE_AGE:(\d+)\]/);
        if (ageM) { user.profile.age = parseInt(ageM[1]); aiReply = aiReply.replace(ageM[0], '').trim(); }

        aiReply += capabilityHint(msg, user);
        reply = aiReply;
        await addToHistory(user, 'assistant', reply);
      }
    } else {
      reply = `סוג הודעה לא נתמך 😅 שלח טקסט או תמונה!`;
    }

    if (reply) await sendWhatsApp(userId, reply);
    await saveUser(user);

  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'מקס פועל! 🚀', mongodb: !!usersCollection, youtube: !!YOUTUBE_API_KEY }));

connectDB().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log('מקס פועל!');
    console.log('MongoDB:', !!MONGODB_URI);
    console.log('YouTube API:', !!YOUTUBE_API_KEY);
    console.log('WhatsApp:', !!WA_TOKEN);
  });
});
