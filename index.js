const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { MongoClient } = require('mongodb');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const VERIFY_TOKEN = 'maxbot123';

let usersCollection;
const memoryCache = {};

// =================== DB ===================
async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db('maxbot');
    usersCollection = db.collection('users');
    await usersCollection.createIndex({ userId: 1 }, { unique: true });
    console.log('MongoDB connected!');
  } catch (err) { console.error('MongoDB error:', err.message); }
}

async function getUser(userId) {
  if (memoryCache[userId]) return memoryCache[userId];
  if (usersCollection) {
    try {
      const doc = await usersCollection.findOne({ userId });
      if (doc) {
        delete doc._id;
        if (doc.history) doc.history = doc.history.map(m => ({ role: m.role, content: m.content }));
        memoryCache[userId] = doc;
        return doc;
      }
    } catch (err) { console.error('getUser error:', err.message); }
  }
  const newUser = {
    userId, createdAt: new Date(), history: [], summaryHistory: [],
    onboardingDay: 1, streak: 0, lastCheckIn: null, todayMeals: [],
    pendingMeal: null,
    profile: { height: null, weight: null, bmi: null, waterGoal: null, age: null, name: null, goals: [], language: null },
    medicalHistory: { conditions: [], medications: [], allergies: [], bloodTests: [], lastBloodTest: null, medicalAsked: false },
    fitnessData: { todaySteps: 0, todayWorkoutMinutes: 0, todayWorkoutType: null, weeklySteps: [], weeklyWorkouts: [], stepGoal: 8000 },
    lastActive: null, waterReminders: 0, weeklyChallenge: null, challengeCompleted: false,
    workoutPlan: null, shownCapabilities: [],
    proactive: { lastRandomMessage: null, randomMessageCount: 0 },
    currentLists: {},  // שמירת רשימות פעילות (תוספים, מאכלים וכו׳)
    personalPlan: {
      supplements: [],      // רשימת תוספים אישית
      protocols: [],        // פרוטוקולים אישיים
      goals: [],            // מטרות
      restrictions: [],     // אלרגיות / מגבלות
      lastUpdated: null,
      hormonalScore: null,  // ניקוד שאלון אחרון
      hormonalScoreDate: null
    }
  };
  memoryCache[userId] = newUser;
  await saveUser(newUser);
  return newUser;
}

async function saveUser(user) {
  if (user.history) user.history = user.history.map(m => ({ role: m.role, content: m.content }));
  memoryCache[user.userId] = user;
  if (!usersCollection) return;
  try {
    await usersCollection.replaceOne({ userId: user.userId }, { ...user, updatedAt: new Date() }, { upsert: true });
  } catch (err) { console.error('saveUser error:', err.message); }
}

// =================== CLAUDE ===================
async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const clean = messages.map(m => ({ role: m.role, content: m.content }));
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages: clean };
  if (systemPrompt) body.system = systemPrompt;
  const res = await axios.post('https://api.anthropic.com/v1/messages', body, {
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  });
  return res.data.content[0].text;
}

async function addToHistory(user, role, content) {
  user.history.push({ role, content });
  if (user.history.length > 40) {
    const toSummarize = user.history.splice(0, 20);
    try {
      const text = toSummarize.map(m => `${m.role === 'user' ? 'User' : 'Max'}: ${m.content}`).join('\n');
      const summary = await callClaude([{ role: 'user', content: `Summarize in 6 sentences. Keep ALL: goals, health data, achievements, supplement lists, food lists, biohacking protocols, any specific items mentioned. Third person.\n\n${text}` }], null, 350);
      user.summaryHistory.push({ summary, date: new Date() });
      if (user.summaryHistory.length > 10) user.summaryHistory = user.summaryHistory.slice(-10);
    } catch (e) { console.error('Summary error:', e.message); }
  }
}

function buildContext(user) {
  const summaryText = user.summaryHistory?.length > 0
    ? '📚 Previous conversations:\n' + user.summaryHistory.map(s => `[${new Date(s.date).toLocaleDateString()}]: ${s.summary}`).join('\n')
    : '';
  const recentHistory = (user.history || []).slice(-30).map(m => ({ role: m.role, content: m.content }));
  return { summaryText, recentHistory };
}

// =================== LANGUAGE DETECTION ===================
function detectLanguage(text) {
  if (/[\u0590-\u05FF]/.test(text)) return 'hebrew';
  if (/[\u0600-\u06FF]/.test(text)) return 'arabic';
  if (/[áéíóúüñ¿¡]/i.test(text)) return 'spanish';
  if (/[àâäéèêëïîôùûüÿç]/i.test(text)) return 'french';
  if (/[äöüß]/i.test(text)) return 'german';
  return 'english';
}

// =================== WHISPER TRANSCRIPTION ===================
async function transcribeAudio(audioBuffer, mimeType) {
  if (!OPENAI_API_KEY) return null;
  try {
    const form = new FormData();
    // המרת mime type לסיומת
    const ext = mimeType.includes('ogg') ? 'ogg' :
                mimeType.includes('mp4') ? 'mp4' :
                mimeType.includes('mpeg') ? 'mp3' :
                mimeType.includes('wav') ? 'wav' : 'ogg';

    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    // Whisper מזהה שפה אוטומטית

    const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      timeout: 30000
    });
    return res.data;
  } catch (err) {
    console.error('Whisper error:', err.response?.data || err.message);
    return null;
  }
}

// =================== SHOPPING LINKS ===================
function buildShoppingLinks(supplementName, lang) {
  const encoded = encodeURIComponent(supplementName);
  const isHeb = lang === 'hebrew';
  return `${isHeb ? '🛒 קנה' : '🛒 Buy'} ${supplementName}:\n` +
    `• iHerb: https://www.iherb.com/search?kw=${encoded}\n` +
    `• Amazon: https://www.amazon.com/s?k=${encoded}\n` +
    `• PubMed: https://pubmed.ncbi.nlm.nih.gov/?term=${encoded}`;
}

function buildMultipleShoppingLinks(supplements, lang) {
  const isHeb = lang === 'hebrew';
  let msg = isHeb ? `🛒 קישורי קנייה לכל התוספים:\n\n` : `🛒 Shopping links for all supplements:\n\n`;
  for (const supp of supplements) {
    const encoded = encodeURIComponent(supp);
    msg += `💊 *${supp}*\n`;
    msg += `   • iHerb: https://www.iherb.com/search?kw=${encoded}\n`;
    msg += `   • Amazon: https://www.amazon.com/s?k=${encoded}\n`;
    msg += `   • מחקר: https://pubmed.ncbi.nlm.nih.gov/?term=${encoded}\n\n`;
  }
  return msg.trim();
}

// פונקציה לחלץ שמות תוספים מתשובה של קלוד
async function extractSupplementsFromText(text) {
  try {
    const result = await callClaude([{
      role: 'user',
      content: `Extract all supplement/vitamin/mineral names from this text. Return ONLY a JSON array of names in English, nothing else. Example: ["Magnesium Glycinate", "Vitamin D3", "Omega-3"]\n\nText: ${text}`
    }], null, 200);
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return [];
  }
}

// =================== INTENT DETECTION ===================
// מנוע הבנת כוונות גמיש — מבין פקודות בכל צורה
async function detectIntent(msg, user, lang) {
  const msgLower = msg.toLowerCase();

  // הוספה לרשימה קיימת
  const addToListPatterns = [
    'הוסף', 'תוסיף', 'תכניס', 'שכחת', 'גם', 'ועוד', 'ומה עם',
    'add', 'also add', 'you forgot', 'what about', 'include', 'and also',
    'ajoute', 'también', 'auch'
  ];

  // שאילתת מחיר / קנייה
  const buyPatterns = [
    'קנייה', 'לקנות', 'איפה לקנות', 'כמה עולה', 'קישור', 'iherb', 'אמזון',
    'buy', 'where to buy', 'price', 'purchase', 'link', 'amazon', 'shop'
  ];

  // בקשת מחקר / מקורות
  const researchPatterns = [
    'מחקר', 'מקור', 'הוכחה', 'מדעי', 'pubmed', 'study',
    'research', 'source', 'evidence', 'scientific', 'prove'
  ];

  // עדכון / תיקון
  const updatePatterns = [
    'תעדכן', 'שנה', 'תקן', 'במקום', 'לא נכון', 'טעית',
    'update', 'change', 'fix', 'instead', 'wrong', 'correct'
  ];

  // בקשה לפרטים נוספים
  const moreDetailsPatterns = [
    'פרט', 'הסבר', 'ספר לי יותר', 'מה זה', 'איך זה עובד',
    'explain', 'more details', 'tell me more', 'how does', 'what is'
  ];

  if (addToListPatterns.some(p => msgLower.includes(p))) return 'add_to_list';
  if (buyPatterns.some(p => msgLower.includes(p))) return 'buy_links';
  if (researchPatterns.some(p => msgLower.includes(p))) return 'research';
  if (updatePatterns.some(p => msgLower.includes(p))) return 'update';
  if (moreDetailsPatterns.some(p => msgLower.includes(p))) return 'more_details';

  return 'general';
}

// =================== SEND WHATSAPP ===================
async function sendWhatsApp(userId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: userId, type: 'text', text: { body: text } },
      { headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('Sent to', userId);
  } catch (err) { console.error('sendWhatsApp error:', err.response?.data || err.message); throw err; }
}

async function sendAndRemember(user, text) {
  await sendWhatsApp(user.userId, text);
  user.history.push({ role: 'assistant', content: text });
  await saveUser(user);
}

// =================== DOWNLOAD MEDIA ===================
async function downloadMedia(mediaId) {
  const mediaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  const fileRes = await axios.get(mediaRes.data.url, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  return {
    base64: Buffer.from(fileRes.data).toString('base64'),
    buffer: Buffer.from(fileRes.data),
    mimeType: mediaRes.data.mime_type || 'image/jpeg'
  };
}

// =================== BMI ===================
function calculateBMI(h, w) {
  const bmi = (w / ((h / 100) ** 2)).toFixed(1);
  const status = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Healthy ✅' : bmi < 30 ? 'Overweight' : 'Obese';
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

// =================== FITNESS — STRICT (NO FALSE POSITIVES) ===================
function parseFitness(msg, user) {
  const msgLower = msg.toLowerCase();
  const isQuestion =
    msg.includes('?') || msgLower.includes('תביא') || msgLower.includes('יכול') ||
    msgLower.includes('תוכל') || msgLower.includes('can you') || msgLower.includes('could you') ||
    msgLower.includes('give me') || msgLower.includes('show me') || msgLower.includes('תראה') ||
    msgLower.includes('תן לי') || msgLower.includes('בנה') || msgLower.includes('צור') ||
    msgLower.includes('create') || msgLower.includes('build') || msgLower.includes('make');

  if (isQuestion) return false;

  const explicitPhrases = [
    'עשיתי אימון', 'סיימתי אימון', 'התאמנתי', 'רצתי', 'שחיתי', 'עשיתי כושר',
    'הלכתי לחדר כושר', 'עשיתי יוגה', 'עשיתי אופניים', 'עשיתי פילאטיס',
    'i worked out', 'i trained', 'i ran', 'i exercised', 'i swam', 'i cycled',
    'finished workout', 'completed workout', 'just finished training', 'went to the gym',
    'just ran', 'just trained', 'did a workout', 'hit the gym'
  ];

  const steps = msg.match(/(\d[\d,]*)\s*(?:צעדים|steps)/i);
  const isExplicit = explicitPhrases.some(p => msgLower.includes(p));
  let updated = false;

  if (steps) { user.fitnessData.todaySteps = parseInt(steps[1].replace(',', '')); updated = true; }
  if (isExplicit) {
    const minutes = msg.match(/(\d+)\s*(?:דק|דקות|min|minutes)/i);
    user.fitnessData.todayWorkoutMinutes += minutes ? parseInt(minutes[1]) : 45;
    updated = true;
  }
  return updated;
}

function fitnessBar(user) {
  const fd = user.fitnessData;
  const goal = fd.stepGoal || 8000;
  const pct = Math.min(100, Math.round(((fd.todaySteps || 0) / goal) * 100));
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  return `📊 Today:\n👟 ${(fd.todaySteps || 0).toLocaleString()}/${goal.toLocaleString()} [${bar}] ${pct}%\n💪 Workout: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} min` : 'Not logged'}`;
}

// =================== YOUTUBE ===================
async function searchYouTube(query) {
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: query, type: 'video', maxResults: 1, relevanceLanguage: 'en', key: YOUTUBE_API_KEY }
    });
    const item = res.data.items?.[0];
    if (!item) return null;
    return { title: item.snippet.title, channel: item.snippet.channelTitle, url: `https://www.youtube.com/watch?v=${item.id.videoId}` };
  } catch (err) { return null; }
}

async function getYouTubeRecommendations(topic, type) {
  const queriesText = await callClaude([{
    role: 'user',
    content: `3 YouTube search queries in ENGLISH for: "${topic}" (${type === 'health' ? 'biohacking/science' : 'exercise/fitness'}). One per line. No numbers.`
  }], null, 100);
  const queries = queriesText.trim().split('\n').filter(q => q.trim()).slice(0, 3);
  let msg = `${type === 'health' ? '🎓' : '🎬'} YouTube: "${topic}"\n\n`;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i].trim();
    const emoji = ['1️⃣', '2️⃣', '3️⃣'][i];
    const video = await searchYouTube(q);
    msg += video
      ? `${emoji} *${video.title}*\n   📺 ${video.channel}\n   🔗 ${video.url}\n\n`
      : `${emoji} ${q}\n   🔗 https://www.youtube.com/results?search_query=${encodeURIComponent(q)}\n\n`;
  }
  return msg.trim();
}

// =================== WORKOUT PLAN WITH YOUTUBE ===================
async function generateWorkoutPlan(user) {
  const lang = user.profile?.language || 'english';
  const plan = await callClaude([{
    role: 'user',
    content: `Max. Science-based weekly workout plan for longevity.
Profile: ${user.profile?.height || '?'}cm | ${user.profile?.weight || '?'}kg | age ${user.profile?.age || '?'}
Limitations: ${user.medicalHistory?.conditions?.join(', ') || 'none'}

💪 WEEKLY PLAN:
📅 Day 1 — [name]:
• [Exercise]: X sets × X reps — YOUTUBE:[exercise english name]
[3-4 exercises]
[All 7 days]
⏱️ ~X min/day | 🧬 Longevity tip: [science tip]
Respond in: ${lang}`
  }], null, 1500);

  const matches = [...plan.matchAll(/YOUTUBE:\[([^\]]+)\]/g)];
  let finalPlan = plan;
  for (const match of matches) {
    const video = await searchYouTube(`${match[1]} proper form tutorial`);
    finalPlan = finalPlan.replace(match[0], video ? `\n   🎬 ${video.url}` : `\n   🎬 https://www.youtube.com/results?search_query=${encodeURIComponent(match[1])}`);
  }
  return finalPlan;
}

// =================== MAX v4.0 PERSONALITY ===================
const MAX_PERSONALITY = `You are "Max" — the world's most advanced personal biohacking coach on WhatsApp. You are powered by Claude (Anthropic) and have deep knowledge of cutting-edge science, longevity research, and human optimization. You feel like talking directly to a brilliant, caring scientist friend.

🌍 LANGUAGE: Always respond in the EXACT same language the user writes in.

🧬 YOUR KNOWLEDGE BASE:
You are inspired by and trained on protocols from:
- Bryan Johnson (Blueprint — most measured human alive)
- Andrew Huberman (Stanford neuroscience — sleep, light, dopamine)  
- Peter Attia (Longevity medicine — Zone 2, VO2max, centenarian decathlon)
- David Sinclair (Harvard — NAD+, sirtuins, information theory of aging)
- Rhonda Patrick (Micronutrients, heat shock proteins, omega-3)
- Wim Hof (Cold exposure, breathwork)
- Ben Greenfield (Comprehensive biohacking)

🎯 YOUR MISSION: Help humans live to 120+ in peak health and performance.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔬 CORE BIOHACKING KNOWLEDGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LONGEVITY SUPPLEMENTS:
• NMN (500-1000mg/morning) — NAD+ precursor, DNA repair [Sinclair]
• Resveratrol (500mg with fat) — sirtuin activation [Sinclair]
• CoQ10 (200-400mg with fat) — mitochondrial energy
• Alpha Lipoic Acid (600mg) — antioxidant recycler
• Pterostilbene — more bioavailable resveratrol

DAILY ESSENTIALS:
• Magnesium Glycinate (300-400mg/night) — sleep, 300+ enzymes
• Vitamin D3 + K2 (2000-5000 IU + 100mcg) — immune, hormone
• Omega-3 EPA+DHA (2-4g/day) — inflammation, brain [Rhonda Patrick]
• Zinc (15-30mg) — testosterone, immune
• Creatine (5g/day) — muscle + brain (most studied supplement)

COGNITIVE:
• Lion's Mane (1000mg) — NGF, neurogenesis
• Bacopa (300mg) — memory consolidation  
• L-Theanine + Caffeine (200mg + 100mg) — calm focus
• Alpha-GPC (300mg) — acetylcholine

PERFORMANCE:
• Ashwagandha KSM-66 (600mg) — cortisol, testosterone
• L-Citrulline (6-8g pre-workout) — nitric oxide
• Beta-Alanine (3.2g) — endurance

SLEEP:
• Magnesium Glycinate (300mg before bed)
• Glycine (3g) — lowers core temp
• Apigenin (50mg) — GABA-A [Huberman]
• L-Theanine (200mg) — calm without sedation

DANGEROUS COMBINATIONS — WARN ALWAYS:
• Blood thinners + fish oil + Vitamin E = bleeding risk
• Calcium + Magnesium = compete for absorption (take separately)
• Iron + Calcium = blocks iron
• St. John's Wort + medications = dangerous interactions
• High dose Vitamin A + pregnancy = harmful

ANTI-INFLAMMATORY FOODS (eat daily):
Wild salmon, olive oil, blueberries, broccoli, turmeric+black pepper, ginger, green tea, walnuts, dark leafy greens, garlic, dark chocolate 85%+

INFLAMMATORY FOODS (avoid):
Seed oils (canola/soybean/corn), refined sugar, white flour, processed meats, trans fats, alcohol excess, artificial sweeteners

CIRCADIAN OPTIMIZATION [Huberman]:
• Morning: 10-30 min outdoor light within 30 min of waking
• Evening: dim warm lights after sunset, blue light blocking
• Sleep: 65-68°F, complete darkness, consistent wake time

COLD EXPOSURE [Wim Hof]:
• Cold shower: 30 sec → build to 3-5 min
• Ice bath: 10-15°C, 2-4 min, 3-4x/week
• NOT after strength training (blunts hypertrophy)

EXERCISE FOR LONGEVITY [Attia]:
• Zone 2: 150-200 min/week (conversational pace)
• VO2max: 4×4 Norwegian protocol
• Strength: progressive overload 3-4x/week
• Grip strength = mortality predictor

FASTING [Sinclair/Attia]:
• 16:8 most practical
• Stop eating 3hrs before sleep
• Break fast with protein+fat not carbs

BIOMARKERS TO OPTIMIZE:
Vitamin D: 50-80 ng/mL | Fasting glucose: <85 | HbA1c: <5.3% | hs-CRP: <0.5 | Homocysteine: <7 | B12: >500

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧬 TESTOSTERONE & HORMONAL HEALTH PROTOCOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HORMONAL CRISIS: Testosterone levels have dropped ~50% since the 1970s. Modern lifestyle = estrogenic environment (plastics, phthalates, BPA, synthetic fragrances). Goal: raise FREE testosterone, not just total.

CRITICAL BLOOD TESTS FOR HORMONAL HEALTH (do 07:00-08:30, fasted):
• Free Testosterone → aim for TOP QUARTER of lab range
• Vitamin D (25-OH) → optimal 60-80 ng/mL (below 30 = deficiency)
• HbA1c → optimal <5.4% (ideally 5.0-5.2%) — insulin sensitivity key
• SHBG → middle of range (too high = testosterone "locked")
• Cortisol AM → within normal, NOT at upper edge (chronic stress = low T)

TESTOSTERONE RANGES (optimal):
Men: age 20-24 → 25-35 nmol/L | 25-34 → 22-30 | 35-44 → 20-28 | 45-54 → 18-26 | 55+ → 16-24
Women: age 16-35 → 1.8-2.8 nmol/L | 36-50 → 1.5-2.5 | 51+ → 1.2-2.0

TESTOSTERONE SUPPLEMENTS — GROUP 1 (production support):
• Magnesium (200-400mg/night) — high-absorption form
• Zinc (15mg with food) + Copper 1:10 ratio — don't take long-term without copper
• Vitamin D3 + K2 (2000-5000 IU/morning with fat)
• Boron (3-10mg/morning with food) — lowers SHBG, raises free testosterone. CYCLE: 2 weeks on, 1 week off
• Vitamin B6 as P5P only (20-50mg/morning or noon)

TESTOSTERONE SUPPLEMENTS — GROUP 2 (cortisol/stress reduction):
• Ashwagandha KSM-66 (300-600mg) — morning or evening depending on goal
• Reishi mushroom (per product) — evening, supports sleep + nervous system

TESTOSTERONE SUPPLEMENTS — GROUP 3 (natural anti-inflammatory):
• Nano-liposomal Curcumin (500-1000mg) — after breakfast or lunch, twice daily
• PH-DIRECT — per instructions, any time of day

TESTOSTERONE SUPPLEMENTS — GROUP 4 (mitochondrial/energy):
• Creatine Monohydrate (3-5g/morning or pre-workout)
• CoQ10 (100-200mg/morning with fat)
• Omega-3 EPA+DHA (1000-2000mg/morning with fat)
• Vitamin E (100-200 IU/morning with fat)

ADVANCED TESTOSTERONE HERBS (use in cycles):
• Tongkat Ali (400mg/day) — cycle to prevent adaptation
• Fadogia Agrestis (600mg/day) — cycle mandatory, supports Leydig cells

RAHIT WORKOUT PROTOCOL (Resilience Adaptive High-Intensity Training):
Best for HGH release. Done on stationary bike, 3x/week, at END of workout:
• Phase 1: 3 min slow meditative pedaling (eyes closed, deep breathing)
• Phase 2: 10 sec ALL-OUT sprint (100% — run for your life!)
• Phase 3: 3 min slow recovery (eyes closed, deep breathing)
• Repeat phases 2-3 twice more = total 3 sprints
• After 3-5 sessions: increase sprints to 15 sec, then 20 sec
Why better than steady cardio: peaks HGH, burns fat for hours, preserves muscle, <12 min total

FASTING FOR TESTOSTERONE (+15%):
• 16:8 intermittent fasting improves Leydig cell function
• Mechanism: improves insulin sensitivity + cellular autophagy
• Break fast with protein+fat, NOT carbs

MORNING LIGHT PROTOCOL FOR HORMONES:
• 20 min direct sunlight within 30 min of waking (no sunglasses)
• Synchronizes circadian rhythm, suppresses nighttime cortisol
• Block blue light in evenings → signals melatonin + sex hormone production

HORMONAL DISRUPTORS — ELIMINATE:
PERSONAL CARE: SLS shampoos, commercial deodorants (aluminum), synthetic fragrances (phthalates), chemical sunscreens → Replace with natural alternatives, crystal deodorant, essential oil blends, mineral zinc-based sunscreen
FOOD STORAGE: Plastic containers (even BPA-free leach chemicals), heating plastic in microwave, plastic water bottles → Replace with glass, stainless steel, ceramic
CLOTHING: Polyester/nylon/spandex, tight clothing (creates heat) → Replace with cotton, bamboo, linen, organic wool. Wash with baking soda + apple cider vinegar
HOME ENVIRONMENT: Synthetic air fresheners, industrial candles, harsh cleaning chemicals → Replace with essential oil diffusers, soy/beeswax candles, vinegar+baking soda cleaning

DOPAMINE & TESTOSTERONE CONNECTION:
Overstimulation (screens, processed food, pornography) → dopamine crashes → suppresses hormonal axis → lower testosterone
Action: eliminate "infinite scroll" especially morning + night. Stable dopamine = stable testosterone

STRESS REDUCTION — 10 METHODS FOR CORTISOL CONTROL:
1. Human/self touch — 20-sec hug, hand on heart, self-massage
2. Free movement — shaking, jumping, dancing freely
3. Conscious breathing — box breathing (4-4-4-4), 4-7-8, or extend exhale
4. Mindful eating — no screens, slow chewing, full presence
5. Nature time — focus on green, trees, any natural environment
6. Grounding — barefoot on earth/grass, hands on tree trunk
7. Gentle movement with breath — Qi Gong, yoga (not intense training)
8. Animal time — pets, watching birds
9. Medicinal herbs — Reishi, Ashwagandha, lavender essential oil
10. Professional therapy — NLP, CBT, emotional therapy — if body won't calm down, get help

TESTOSTERONE HORMONAL ASSESSMENT (21 QUESTIONS):
If user asks about hormonal status, you can guide them through a self-assessment scoring 1-3 per question:
Energy on waking | Natural libido (no external stimulation) | Internal motivation | Exercise regularly | Energy at workout | 100% effort at workout | Dynamism through day | Recovery ease | Stable energy (no crashes) | Social interactions weekly | Avoiding plastic containers | Habit consistency | Quality protein each meal | Avoiding processed food | Confident decisions | Deep restorative sleep | Daily enthusiasm/excitement | Avoiding commercial deodorants/fragrances | Avoiding synthetic clothing | Phone away during sleep | Sleeping in complete darkness
Score: 21-30 = needs deep work | 31-45 = on the way | 46-63 = strong foundation

PRACTICAL DAILY TIPS FOR TESTOSTERONE:
• Avoid tight pants or laptop on lap (heat kills testosterone production)
• Replace plastic kitchen with glass/stainless/ceramic
• No heating food in plastic — ever
• Natural deodorant (crystal stone, paste, or essential oils)
• Natural fabrics only (cotton, bamboo, linen)
• Morning light first, screens second
• Resistance training: compound moves (squat, deadlift) max 60 min (longer = cortisol spike)
• Sleep 7-8 hrs — most testosterone produced during deep sleep
• Phone charging outside bedroom
⚕️ Always suggest doctor consultation for hormonal issues. Never recommend prescription drugs (finasteride, spironolactone etc.) — only natural protocols.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 INTELLIGENCE & CONTEXT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FLEXIBLE UNDERSTANDING — CRITICAL:
You understand natural language. If user says:
- "הוסף X" / "שכחת Y" / "ומה עם Z" → ADD to the previous list/recommendation
- "תעדכן" / "שנה" → UPDATE what was said
- "תפרט" / "ספר יותר" → EXPAND on previous topic
- "קנייה" / "לקנות" / "iherb" → Provide shopping links
- "מחקר" / "הוכחה" → Provide PubMed links
Always check conversation history and context before responding.

WORKOUT CONTEXT — NEVER ASSUME:
Only update fitness data if user EXPLICITLY reports completing exercise.
Questions like "give me a workout" or "can you..." are NOT exercise reports.

LIST MANAGEMENT:
When you give a supplement/food list, remember it. If user asks to add/remove items, update the full list and show it complete with all changes.

PROACTIVE SHOPPING:
After giving supplement recommendations, offer links AS TEXT ONLY — no URLs:
Say: "רוצה קישורי קנייה ל-iHerb? כתוב קישורי קנייה" / "Want iHerb links? Say shopping links"
NEVER include actual URLs or iherb.com links unless user explicitly asks.

SUPPLEMENT RULES — CRITICAL:
1. Always recommend from the approved supplement list in your knowledge base. Never invent supplements not listed there.
2. Be CONSISTENT — same goal = same supplements every time.
3. ALWAYS add disclaimer when discussing supplements:
   Hebrew: "אני לא רופא — המידע הוא בגדר המלצה בלבד. התייעץ עם רופא לפני נטילת תוספים."
   English: "I am not a doctor — all info is educational only. Consult your doctor before taking supplements."

REPLY AWARENESS:
If user replies to a specific message, address that specific content directly.

📋 ONBOARDING:
Day 1: name, age, goals, routine, height, weight
Day 2: nutrition, sleep, activity, stress, current supplements
Day 3: what hasn't worked, obstacles, time available

📌 [SAVE_BMI:h:w] | [SAVE_NAME:name] | [SAVE_AGE:age]

💪 STYLE: Max 5 lines, emojis, one question, energetic, science-backed.
Always connect to longevity. First message: greeting + ask name!
⚕️ Never recommend prescription drugs. Always suggest consulting doctor.`;


// =================== PERSONAL PLAN ===================
function buildUserContext(user) {
  const p = user.profile || {};
  const m = user.medicalHistory || {};
  const f = user.fitnessData || {};
  const plan = user.personalPlan || {};
  return `
USER PROFILE:
Name: ${p.name || 'Unknown'} | Age: ${p.age || '?'} | Height: ${p.height || '?'}cm | Weight: ${p.weight || '?'}kg | BMI: ${p.bmi || '?'}
Goals: ${p.goals?.join(', ') || 'not set'}
Conditions: ${m.conditions?.join(', ') || 'none'}
Medications: ${m.medications?.join(', ') || 'none'}
Allergies: ${m.allergies?.join(', ') || 'none'}
Last blood test: ${m.lastBloodTest || 'none'}
Steps today: ${f.todaySteps || 0} | Workout today: ${f.todayWorkoutMinutes || 0} min | Streak: ${user.streak || 0} days
Hormonal score: ${plan.hormonalScore ? `${plan.hormonalScore}/105 (${plan.hormonalScoreDate})` : 'not assessed'}
Current supplement plan: ${plan.supplements?.length > 0 ? plan.supplements.join(', ') : 'none set'}
Current protocols: ${plan.protocols?.length > 0 ? plan.protocols.join(', ') : 'none set'}
`.trim();
}

async function getPersonalPlan(user, lang) {
  const isHeb = lang === 'hebrew';
  const plan = user.personalPlan || {};
  const context = buildUserContext(user);

  if (!plan.supplements?.length && !plan.protocols?.length) {
    return isHeb
      ? `📋 *התוכנית האישית שלך*

עדיין לא בנינו תוכנית אישית! 🔍

כדי לבנות תוכנית מדויקת, שלח:
• 🧬 "בנה לי תוכנית" — ואנתח את כל הנתונים שלך
• 📋 "שאלון הורמונלי" — להערכת המצב הנוכחי
• 🩸 "בדיקת דם" + התוצאות שלך`
      : `📋 *Your Personal Plan*

No personal plan built yet! 🔍

To build your plan, send:
• 🧬 "Build my plan" — I'll analyze all your data
• 📋 "Hormonal questionnaire" — assess current status
• 🩸 "Blood test" + your results`;
  }

  return await callClaude([{ role: 'user', content: `Max v4. Display this user's complete personal biohacking plan in a clear, organized format.

${context}

Format:
👤 *[Name]'s Personal Protocol*
━━━━━━━━━━━━━━━
🎯 *Goals:* [list]
━━━━━━━━━━━━━━━
💊 *Supplement Stack:*
[each supplement with dose + timing]
━━━━━━━━━━━━━━━
🔬 *Daily Protocols:*
[each protocol]
━━━━━━━━━━━━━━━
📊 *Hormonal Score:* [score if available]
━━━━━━━━━━━━━━━
⚕️ Not a doctor — consult physician before changes.

Respond in: ${lang}` }], null, 800);
}

async function buildPersonalPlan(user, lang) {
  const context = buildUserContext(user);
  const isHeb = lang === 'hebrew';

  const result = await callClaude([{ role: 'user', content: `Max v4. Build a PERSONALIZED biohacking protocol based on this user's exact data.

${context}

RULES:
- Only use supplements from the approved list in your knowledge base
- Tailor everything to their age, BMI, conditions, goals
- If data is missing, note what's needed for better personalization
- Be specific: exact doses, exact timing, exact protocols

Format:
🎯 *Primary Goals Identified:* [based on their data]
━━━━━━━━━━━━━━━
💊 *Personalized Supplement Stack:*
💊 [Name] | [dose] | [timing] | [why specifically for THIS user]
━━━━━━━━━━━━━━━
🔬 *Daily Protocol:*
🌅 Morning: [specific actions]
🌞 Afternoon: [specific actions]
🌙 Evening: [specific actions]
━━━━━━━━━━━━━━━
🏋️ *Training Protocol:* [based on their fitness data]
━━━━━━━━━━━━━━━
🥗 *Nutrition Focus:* [based on their profile]
━━━━━━━━━━━━━━━
⚠️ *Watch out for:* [based on conditions/medications]
━━━━━━━━━━━━━━━
📈 *Next steps to improve this plan:* [what data is still missing]
⚕️ Disclaimer in ${lang}

Respond in: ${lang}` }], null, 1200);

  // שמור את התוכנית בפרופיל המשתמש
  const supplements = await extractSupplementsFromText(result);
  if (!user.personalPlan) user.personalPlan = { supplements: [], protocols: [], goals: [], restrictions: [], lastUpdated: null, hormonalScore: null, hormonalScoreDate: null };
  if (supplements.length > 0) user.personalPlan.supplements = supplements;
  user.personalPlan.lastUpdated = new Date().toISOString();

  return result;
}

async function addToPersonalPlan(user, msg, lang) {
  const isHeb = lang === 'hebrew';
  if (!user.personalPlan) user.personalPlan = { supplements: [], protocols: [], goals: [], restrictions: [], lastUpdated: null, hormonalScore: null, hormonalScoreDate: null };

  // חלץ מה להוסיף מהבקשה
  const extracted = await callClaude([{ role: 'user', content: `Extract what the user wants to add to their supplement/protocol plan from this message: "${msg}".
Current plan supplements: ${user.personalPlan.supplements?.join(', ') || 'none'}
Return ONLY a JSON: {"supplements": ["name with dose"], "protocols": ["protocol description"], "goals": ["goal"]}
Only include items actually mentioned. Return empty arrays if nothing relevant.` }], null, 200);

  try {
    const cleaned = extracted.replace(/\`\`\`json|\`\`\`/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const added = [];
    if (parsed.supplements?.length) {
      for (const s of parsed.supplements) {
        if (!user.personalPlan.supplements.includes(s)) {
          user.personalPlan.supplements.push(s);
          added.push(s);
        }
      }
    }
    if (parsed.protocols?.length) {
      for (const p of parsed.protocols) {
        if (!user.personalPlan.protocols.includes(p)) {
          user.personalPlan.protocols.push(p);
          added.push(p);
        }
      }
    }
    if (parsed.goals?.length) {
      for (const g of parsed.goals) {
        if (!user.personalPlan.goals.includes(g)) {
          user.personalPlan.goals.push(g);
        }
      }
    }
    user.personalPlan.lastUpdated = new Date().toISOString();

    if (added.length > 0) {
      const list = user.personalPlan.supplements.map(s => `💊 ${s}`).join('\n');
      return isHeb
        ? `✅ הוספתי לתוכנית האישית שלך:\n${list}\n\n📋 כתוב "התוכנית שלי" לצפייה בתוכנית המלאה`
        : `✅ Added to your personal plan:\n${list}\n\n📋 Say "my plan" to view your full plan`;
    }
  } catch(e) {}

  return isHeb
    ? `לא הצלחתי להבין מה להוסיף. נסה: "הוסף מגנזיום 400mg לפני שינה"`
    : `Couldn't understand what to add. Try: "add Magnesium 400mg before sleep"`;
}

// =================== BIOHACKING PROTOCOLS ===================
async function getBiohackingProtocol(topic, lang) {
  return await callClaude([{
    role: 'user',
    content: `Max v4. Detailed science-based protocol for: "${topic}".
Include: mechanism, specific protocol, who pioneered it, timeline, warnings.
Add shopping links format: SUPPLEMENT:[name] for each supplement mentioned.
Respond in: ${lang}`
  }], null, 800);
}

async function getSupplementStack(goal, user, lang) {
  const isHeb = lang === 'hebrew';
  const result = await callClaude([{
    role: 'user',
    content: `Max v4. Supplement stack for: "${goal}".
User: age ${user.profile?.age || '?'}, conditions: ${user.medicalHistory?.conditions?.join(', ') || 'none'}

STRICT RULES:
- Use ONLY supplements from this approved list. Do NOT invent others:
  GROUP 1 (core): Magnesium Glycinate 300-400mg/night | Vitamin D3+K2 2000-5000IU/morning with fat | Zinc 15mg with food (+ Copper 1.5mg) | Omega-3 EPA+DHA 1000-2000mg/morning | Creatine 5g/day
  GROUP 2 (testosterone/hormonal): Boron 3-10mg/morning (cycle 2 weeks on/1 week off) | Vitamin B6 as P5P 20-50mg/morning | Tongkat Ali 400mg/day (cycle) | Fadogia Agrestis 600mg/day (cycle)
  GROUP 3 (stress/cortisol): Ashwagandha KSM-66 300-600mg | Reishi per product label evening
  GROUP 4 (longevity): NMN 500-1000mg/morning | CoQ10 100-200mg/morning with fat | Alpha Lipoic Acid 600mg | Resveratrol 500mg with fat
  GROUP 5 (anti-inflammatory): Nano-liposomal Curcumin 500-1000mg after meal | Vitamin E 100-200IU/morning
  GROUP 6 (cognitive): Lions Mane 1000mg | L-Theanine 200mg | Alpha-GPC 300mg
- Give EXACTLY the same supplements every time for the same goal
- NO shopping links, NO URLs, NO iHerb links in this response
- Always end with the disclaimer

Format each supplement:
💊 [Name] | [Exact dose + timing] | [Why it helps for this goal] | [Evidence level]

After the list add:
⚠️ Dangerous combinations: list relevant ones
⚕️ ${isHeb ? 'אני לא רופא — כל המידע הוא בגדר המלצה בלבד. התייעץ עם רופא לפני נטילת תוספים, במיוחד אם אתה נוטל תרופות.' : 'I am not a doctor — all information is for educational purposes only. Consult your doctor before taking supplements, especially if on medication.'}

Respond in: ${lang}`
  }], null, 900);

  const disclaimer = isHeb
    ? '\n\n💡 רוצה קישורי קנייה ל-iHerb? כתוב "קישורי קנייה"'
    : '\n\n💡 Want iHerb shopping links? Say "shopping links"';
  return result + disclaimer;
}

async function extractSupplementsFromText(text) {
  try {
    const result = await callClaude([{
      role: 'user',
      content: `Extract all supplement/vitamin/mineral names from this text. Return ONLY a JSON array in English. Example: ["Magnesium Glycinate", "Vitamin D3"]\n\nText: ${text.substring(0, 1000)}`
    }], null, 200);
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch (e) { return []; }
}

async function getAntiInflammatoryPlan(lang) {
  return await callClaude([{
    role: 'user',
    content: `Max v4. Anti-inflammatory eating guide.
🟢 EAT DAILY: [top 10 + mechanism]
🟡 EAT WEEKLY: [top 5]
🔴 AVOID: [top 10 + why they cause inflammation]
⚡ Quick win: one change today
🧬 Science: [key mechanism]
Respond in: ${lang}`
  }], null, 700);
}

async function getTestosteroneProtocol(topic, user, lang) {
  const age = user.profile?.age || '?';
  const gender = user.profile?.gender || 'unknown';
  return await callClaude([{
    role: 'user',
    content: `Max v4. Testosterone & hormonal optimization protocol for: "${topic}".
User: age ${age}, conditions: ${user.medicalHistory?.conditions?.join(', ') || 'none'}

Use this knowledge:
- Modern hormonal crisis: ~50% drop in testosterone since 1970s due to EDCs
- Free testosterone is the key metric (not total)
- Lifestyle foundation MUST come before supplements
- RAHIT protocol for HGH: 3 min slow → 10 sec sprint × 3, on stationary bike
- Morning light (20 min, no sunglasses) synchronizes hormonal axis
- 16:8 fasting improves Leydig cell function (+15% testosterone)
- Boron (3-10mg, 2 weeks on/1 week off) lowers SHBG
- Tongkat Ali 400mg + Fadogia Agrestis 600mg — use in cycles
- Eliminate: plastics, synthetic fragrances, phthalates, tight clothing
- Dopamine management: reduce overstimulation for stable testosterone
- Cortisol is the enemy: box breathing, grounding, sleep, nature

Format:
🧬 [mechanism in simple terms]
📋 [specific protocol steps]
💊 [relevant supplements with doses + timing]
⚠️ [warnings/cycling notes]
🔬 [recommended blood tests if relevant]
⚕️ Consult doctor disclaimer.
Respond in: ${lang}`
  }], null, 1000);
}

async function generateChallenge(user) {
  const lang = user.profile?.language || 'english';
  return await callClaude([{
    role: 'user',
    content: `Max. Weekly biohacking challenge. Streak: ${user.streak}.
🏆 Challenge: [biohacking-based]
📋 Mission: [specific + measurable]
🧬 Science: [why it helps longevity]
🎯 Success: [clear metric]
💡 Tip: [practical]
Reply "challenge complete" 🎉 Respond in: ${lang}`
  }], null, 400);
}

async function analyzeBloodTest(data, profile, med, lang) {
  return await callClaude([{
    role: 'user',
    content: `Max v4 — functional medicine guide. Analyze with OPTIMAL ranges.
Profile: age ${profile.age || '?'}, ${profile.height || '?'}cm, ${profile.weight || '?'}kg
Conditions: ${med.conditions?.join(', ') || 'none'}
Results: ${data}

✅ Optimal | ⚡ Suboptimal | ⚠️ Borderline | 🚨 Abnormal → see doctor
💊 Deficiencies + food sources + supplement fix
🔗 Patterns suggesting underlying issues
🥗 Top 3 dietary changes
For each supplement recommended, note it clearly.
⚕️ Consult doctor disclaimer.
Respond in: ${lang}`
  }], null, 1500);
}

// =================== PROACTIVE ===================
async function randomProactive(user) {
  const name = user.profile?.name || '';
  const lang = user.profile?.language || 'english';
  const lastSummary = user.summaryHistory?.slice(-1)[0]?.summary || '';

  const topics = [
    'cold exposure dopamine norepinephrine', 'Zone 2 mitochondrial biogenesis',
    'NAD+ NMN aging', 'circadian rhythm cortisol optimization',
    'gut microbiome brain axis', 'sauna heat shock proteins longevity',
    'Wim Hof breathwork stress resilience', 'blood glucose aging glycation',
    'sleep glymphatic brain cleaning', 'VO2 max longevity predictor',
    'intermittent fasting autophagy', 'omega-3 inflammation resolution',
    'magnesium deficiency enzymes', 'grip strength mortality',
    'Bryan Johnson Blueprint protocol', 'David Sinclair aging theory',
    'Andrew Huberman morning protocol', 'Peter Attia centenarian decathlon',
    'hormesis stress adaptation', 'red light therapy mitochondria'
  ];

  const topic = topics[Math.floor(Math.random() * topics.length)];
  const types = [
    () => callClaude([{ role: 'user', content: `Max v4. Surprising biohacking insight: "${topic}". ${name ? `User: ${name}.` : ''} ${lastSummary ? `Context: ${lastSummary}` : ''}\n🧬 [Surprising fact + mechanism] + one action for TODAY + question. Max 4 lines. Respond in: ${lang}` }], null, 150),
    () => callClaude([{ role: 'user', content: `Max v4. Longevity science fact most people don't know. Connect to action. 🔬 [Fact] + why it matters + question. 3 lines. Respond in: ${lang}` }], null, 130),
    () => callClaude([{ role: 'user', content: `Max v4. Spontaneous personal message to ${name || 'user'}. ${lastSummary ? `Based on: ${lastSummary}` : ''} Streak: ${user.streak}. Feel like coach who just thought of something relevant. 3 lines + question. Respond in: ${lang}` }], null, 130),
    () => callClaude([{ role: 'user', content: `Max v4. Mini biohacking challenge 24hrs. Simple, measurable, scientific. ⚡ [action] + mechanism + "will you try?" 3 lines. Respond in: ${lang}` }], null, 120),
    () => callClaude([{ role: 'user', content: `Max v4. Share protocol from Huberman/Attia/Sinclair/Johnson. Credit source. 👨‍🔬 [Name]: [protocol] + why it works + question. 3 lines. Respond in: ${lang}` }], null, 130),
  ];
  return await types[Math.floor(Math.random() * types.length)]();
}

function capabilityHint(msg, user) {
  const shown = user.shownCapabilities || [];
  const m = msg.toLowerCase();
  const lang = user.profile?.language || 'english';
  const isHeb = lang === 'hebrew';
  const caps = [
    { id: 'blood_test', triggers: ['עייפות', 'עייף', 'חלש', 'אנרגיה', 'tired', 'fatigue', 'energy'], hint: isHeb ? `\n\n🔬 אגב — אני מנתח בדיקות דם עם טווחים אופטימליים, לא רק נורמליים!` : `\n\n🔬 By the way — I analyze blood tests with OPTIMAL ranges, not just normal!` },
    { id: 'whisper', triggers: ['להקליד', 'לכתוב', 'type', 'write'], hint: isHeb ? `\n\n🎤 אגב — אתה יכול לשלוח הודעות קוליות! אני מתמלל אוטומטית 😎` : `\n\n🎤 By the way — you can send voice messages! I transcribe automatically 😎` },
    { id: 'iherb', triggers: ['תוסף', 'ויטמין', 'supplement', 'vitamin', 'לקנות', 'buy'], hint: isHeb ? `\n\n🛒 אגב — אני יכול לשלוח קישורי קנייה ישירים ל-iHerb לכל תוסף!` : `\n\n🛒 By the way — I can send direct iHerb shopping links for every supplement!` },
    { id: 'youtube', triggers: ['תרגיל', 'אימון', 'exercise', 'workout'], hint: isHeb ? `\n\n🎬 אגב — כל תוכנית אימונים כוללת קישורי YouTube לכל תרגיל!` : `\n\n🎬 By the way — every workout plan includes YouTube links for every exercise!` },
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

// =================== CRONS ===================
cron.schedule('0 8 * * *', async () => {
  const users = await getActiveUsers(48);
  for (const user of users) {
    try {
      const lang = user.profile?.language || 'english';
      const q = await callClaude([{ role: 'user', content: `Max v4. Morning biohacking message. ${user.profile?.name ? `Name: ${user.profile.name}.` : ''} Streak: ${user.streak || 0}.\n🌅 Good morning! 💬 "[longevity quote]" — [scientist]\n🧬 Today's protocol: [one specific biohacking action]\nWhat's your plan? 💪 Respond in: ${lang}` }], null, 170);
      await sendAndRemember(user, q);
    } catch (e) { console.error('Morning error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 13 * * *', async () => {
  const users = await getActiveUsers(24);
  for (const user of users) {
    try {
      const lang = user.profile?.language || 'english';
      const tip = await callClaude([{ role: 'user', content: `Max v4. Midday energy/focus biohacking tip. 1 sentence. Respond in: ${lang}` }], null, 80);
      const isHeb = lang === 'hebrew';
      const msg = isHeb
        ? `⚡ עדכון צהריים!\n${user.todayMeals?.length > 0 ? `🍽️ ${user.todayMeals.length} ארוחות` : '📸 שלח תמונת אוכל!'}\n${user.fitnessData?.todaySteps > 0 ? `👟 ${user.fitnessData.todaySteps.toLocaleString()} צעדים` : '👟 דווח על צעדים!'}\n\n🧬 ${tip}`
        : `⚡ Midday check!\n${user.todayMeals?.length > 0 ? `🍽️ ${user.todayMeals.length} meals` : '📸 Log a meal!'}\n${user.fitnessData?.todaySteps > 0 ? `👟 ${user.fitnessData.todaySteps.toLocaleString()} steps` : '👟 Log steps!'}\n\n🧬 ${tip}`;
      await sendAndRemember(user, msg);
    } catch (e) { console.error('Midday error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 20 * * *', async () => {
  const users = await getActiveUsers(24);
  for (const user of users) {
    try {
      const lang = user.profile?.language || 'english';
      const sleepTip = await callClaude([{ role: 'user', content: `Max. One sleep optimization tip from Huberman/Attia/Johnson. 1 sentence. Respond in: ${lang}` }], null, 80);
      const fd = user.fitnessData || {};
      const goal = fd.stepGoal || 8000;
      const icon = (fd.todaySteps || 0) >= goal ? '✅' : (fd.todaySteps || 0) > 0 ? '⚡' : '❌';
      const isHeb = lang === 'hebrew';
      const msg = isHeb
        ? `🌙 סיכום יום!\n${icon} צעדים: ${(fd.todaySteps || 0).toLocaleString()}/${goal.toLocaleString()}\n💪 אימון: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} דקות` : 'לא דווח'}\n🍽️ ארוחות: ${user.todayMeals?.length || 0} | 🔥 רצף: ${user.streak || 0}\n😴 ${sleepTip}`
        : `🌙 Daily summary!\n${icon} Steps: ${(fd.todaySteps || 0).toLocaleString()}/${goal.toLocaleString()}\n💪 Workout: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} min` : 'Not logged'}\n🍽️ Meals: ${user.todayMeals?.length || 0} | 🔥 Streak: ${user.streak || 0}\n😴 ${sleepTip}`;
      await sendAndRemember(user, msg);
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
        const msg = await randomProactive(user);
        await sendAndRemember(user, msg);
        if (!user.proactive) user.proactive = {};
        user.proactive.lastRandomMessage = new Date();
        user.proactive.randomMessageCount = (user.proactive.randomMessageCount || 0) + 1;
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
      await sendAndRemember(user, ch);
    } catch (e) { console.error('Challenge error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 */2 * * *', async () => {
  const h = new Date().getHours();
  if (h < 8 || h > 22) return;
  const users = await getActiveUsers(24);
  for (const user of users) {
    const goal = user.profile?.waterGoal || 2500;
    const lang = user.profile?.language || 'english';
    const msgs = lang === 'hebrew'
      ? [`💧 זמן לשתות! ${goal}ml מטרה 🙏`, `💦 מים = ביצועים + אריכות חיים 💪`, `🌊 ${goal}ml ביום — שתית? 🎯`]
      : [`💧 Hydration time! ${goal}ml goal 🙏`, `💦 Water = performance + longevity 💪`, `🌊 ${goal}ml/day — did you drink? 🎯`];
    try { await sendWhatsApp(user.userId, msgs[Math.floor(Math.random() * msgs.length)]); }
    catch (e) { console.error('Water error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== WEBHOOK ===================
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

    // זיהוי שפה
    if (message.type === 'text') {
      const detected = detectLanguage(message.text.body);
      if (!user.profile.language) user.profile.language = detected;
    }

    const today = new Date().toDateString();
    if (user.lastCheckIn !== today) {
      user.streak = (user.streak || 0) + 1;
      user.lastCheckIn = today;
      user.todayMeals = [];
      user.waterReminders = 0;
      if (user.fitnessData) { user.fitnessData.todaySteps = 0; user.fitnessData.todayWorkoutMinutes = 0; user.fitnessData.todayWorkoutType = null; }
    }

    const lang = user.profile?.language || 'english';
    const isHeb = lang === 'hebrew';
    let reply = '';

    // =================== 🎤 הודעה קולית — Whisper ===================
    if (message.type === 'audio') {
      await sendWhatsApp(userId, isHeb ? `🎤 מתמלל... רגע אחד!` : `🎤 Transcribing... one moment!`);
      try {
        const { buffer, mimeType } = await downloadMedia(message.audio.id);
        const transcript = await transcribeAudio(buffer, mimeType);

        if (transcript && transcript.trim().length > 2) {
          console.log('Transcribed:', transcript.substring(0, 100));
          // עבד את הטרנסקריפט כאילו זה טקסט רגיל
          await addToHistory(user, 'user', `[קולי]: ${transcript}`);
          const { summaryText, recentHistory } = buildContext(user);
          const system = MAX_PERSONALITY + buildStatusContext(user, lang, summaryText);
          let aiReply = await callClaude(recentHistory, system, 1000);
          aiReply = await processAIReply(aiReply, user, transcript, lang);
          reply = `🎤 *שמעתי:* "${transcript}"\n\n${aiReply}`;
          await addToHistory(user, 'assistant', reply);
        } else {
          reply = isHeb
            ? `🎤 לא הצלחתי לתמלל את ההודעה הקולית 😅\nנסה לדבר ברור יותר או כתוב בטקסט 💪`
            : `🎤 Couldn't transcribe the voice message 😅\nTry speaking more clearly or type instead 💪`;
        }
      } catch (e) {
        console.error('Voice processing error:', e.message);
        reply = isHeb ? `🎤 שגיאה בתמלול. כתוב בטקסט! 💪` : `🎤 Transcription error. Please type! 💪`;
      }

    // =================== 💪 תמונת גוף ===================
    } else if (message.type === 'image' && user.pendingMeal === 'body_photo') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      reply = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Max v4. Analyze body composition scientifically. ${user.profile.height || '?'}cm, ${user.profile.weight || '?'}kg, age ${user.profile.age || '?'}.
📊 Body fat % estimate | 💪 Body type | 🎯 Areas to improve | ✅ Strengths | 🧬 Top 3 biohacking recommendations for body composition
Be specific and science-based. Respond in: ${lang}` }
      ]}], null, 700);
      user.pendingMeal = null;

    // =================== 🔬 תמונת בדיקת דם ===================
    } else if (message.type === 'image' && user.pendingMeal === 'blood_test_photo') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      await sendWhatsApp(userId, isHeb ? `🔬 מנתח בדיקות דם עם טווחים אופטימליים...` : `🔬 Analyzing with optimal ranges...`);
      reply = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Max v4. Read and analyze blood test using OPTIMAL ranges. Age ${user.profile.age || '?'}.
✅ Optimal | ⚡ Suboptimal | ⚠️ Borderline | 🚨 Abnormal
💊 Deficiencies + fix | 🔗 Patterns | 🥗 Top 3 dietary changes | ⚕️ See doctor
Respond in: ${lang}` }
      ]}], null, 1500);
      user.medicalHistory.lastBloodTest = new Date().toISOString();
      user.pendingMeal = null;

    // =================== 🖼️ תמונה כללית ===================
    } else if (message.type === 'image') {
      const { base64, mimeType } = await downloadMedia(message.image.id);

      // נבדוק מה בתמונה — אוכל, תרגיל, מסמך, גוף, אחר
      const imageType = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `What type of image is this? Reply with ONLY one word: FOOD, EXERCISE, DOCUMENT, BODY, LABEL, or OTHER` }
      ]}], null, 20);

      const imgTypeLower = imageType.trim().toLowerCase();

      if (imgTypeLower.includes('food')) {
        // ניתוח אוכל
        const full = await callClaude([{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `Max v4 nutrition. Analyze food. Hand = scale.
🍽️ What | 🔥 Calories | 💪 Protein | 🍞 Carbs | 🍬 Sugar | 🥑 Fat
🧂 Key minerals | 🧬 Anti-inflammatory score (1-10)
💡 Biohacking nutrition tip
❓ Accurate? Correct or say "save"
DATA:{"calories":0,"protein":0,"carbs":0,"fat":0,"sugar":0,"minerals":{"iron":0,"calcium":0,"potassium":0,"magnesium":0,"sodium":0,"zinc":0,"vitC":0,"vitD":0,"vitB12":0}}
Respond in: ${lang}` }
        ]}], null, 1000);
        const dm = full.match(/DATA:(\{.*?\})/s);
        if (dm) { try { user.pendingMeal = { data: JSON.parse(dm[1]), time: new Date().toLocaleTimeString() }; } catch (e) {} }
        reply = full.replace(/DATA:\{.*?\}/s, '').trim();

      } else if (imgTypeLower.includes('exercise') || imgTypeLower.includes('body')) {
        // ניתוח תנוחה / גוף
        reply = await callClaude([{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `Max v4. Analyze what you see — if it's an exercise, analyze form and technique. If it's a body, analyze composition. Give specific, actionable feedback. Respond in: ${lang}` }
        ]}], null, 600);

      } else if (imgTypeLower.includes('document') || imgTypeLower.includes('label')) {
        // קריאת מסמך / תווית
        reply = await callClaude([{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `Max v4. Read and analyze this document/label from a health/nutrition/supplement perspective. What's important here? What should the user know? Respond in: ${lang}` }
        ]}], null, 700);

      } else {
        // תמונה כללית
        reply = await callClaude([{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `Max v4. Analyze this image from a health and biohacking perspective. What do you see? Any health-relevant observations? Respond in: ${lang}` }
        ]}], null, 500);
      }

    // =================== 💬 טקסט ===================
    } else if (message.type === 'text') {
      const msg = message.text.body.trim();

      // בדוק אם זה reply להודעה ספציפית
      const replyContext = message.context?.id ? `[User is replying to a previous message]` : '';

      const msgLower = msg.toLowerCase();
      const fitnessUpdated = parseFitness(msg, user);

      // ===== שמירת ארוחה =====
      const saveWords = ['שמור', 'save', 'guardar', 'sauvegarder'];
      if (saveWords.some(w => msgLower === w)) {
        if (user.pendingMeal?.data) {
          user.todayMeals.push(user.pendingMeal); user.pendingMeal = null;
          reply = isHeb ? `✅ נשמר! ${user.todayMeals.length} ארוחות היום 📊` : `✅ Saved! ${user.todayMeals.length} meals today 📊`;
        } else { reply = isHeb ? `אין ארוחה ממתינה 😅` : `No pending meal 😅`; }

      // ===== קישורי קנייה — iHerb =====
      } else if (
        msgLower.includes('iherb') || msgLower.includes('איהרב') ||
        msgLower.includes('לקנות') || msgLower.includes('קנייה') || msgLower.includes('קישורים') ||
        (msgLower.includes('buy') && msgLower.includes('supplement')) ||
        msgLower.includes('where to buy') || msgLower.includes('shopping')
      ) {
        // נחלץ תוספים מההיסטוריה האחרונה
        const recentText = user.history.slice(-10).map(h => h.content).join(' ');
        const supplements = await extractSupplementsFromText(recentText);
        if (supplements.length > 0) {
          reply = buildMultipleShoppingLinks(supplements, lang);
          reply += isHeb ? '\n\n💡 לחץ על הקישורים לקנייה ישירה!' : '\n\n💡 Click the links to buy directly!';
        } else {
          // ממתינים לפרט תוסף ספציפי
          const specific = msg.replace(/iherb|איהרב|לקנות|קנייה|קישורים|buy|where to buy|shopping/gi, '').trim();
          if (specific.length > 2) {
            reply = buildShoppingLinks(specific, lang);
          } else {
            reply = isHeb
              ? `🛒 איזה תוסף אתה רוצה לקנות?\nציין שם ואשלח קישורים ל-iHerb, Amazon ו-PubMed!`
              : `🛒 Which supplement do you want to buy?\nMention the name and I'll send iHerb, Amazon & PubMed links!`;
          }
        }

      // ===== כושר שלי =====
      } else if (msgLower.includes('כושר שלי') || msgLower.includes('my fitness') || msgLower.includes('סטטוס')) {
        reply = fitnessBar(user);

      // ===== דיווח כושר =====
      } else if (fitnessUpdated) {
        reply = await callClaude([{ role: 'user', content: `Max v4. React to workout/steps report. Steps: ${user.fitnessData.todaySteps}, workout: ${user.fitnessData.todayWorkoutMinutes} min. Add recovery biohacking tip. Short + energetic. Respond in: ${lang}` }], null, 170);

      // ===== תוספים + קישורי קנייה =====
      } else if (msgLower.includes('תוספים') || msgLower.includes('supplements') || msgLower.includes('stack') || msgLower.includes('ויטמינים') || msgLower.includes('vitamins')) {
        const goal = msg.replace(/תוספים|supplements|stack|ויטמינים|vitamins|מומלצים|recommended/gi, '').trim() || 'longevity and performance';
        reply = await getSupplementStack(goal, user, lang);

      // ===== אנטי דלקת =====
      } else if (msgLower.includes('אנטי דלקת') || msgLower.includes('anti-inflammatory') || msgLower.includes('inflammation') || msgLower.includes('דלקת')) {
        reply = await getAntiInflammatoryPlan(lang);

      // ===== פרוטוקול =====
      } else if (msgLower.includes('פרוטוקול') || msgLower.includes('protocol') || msgLower.includes('שגרת בוקר') || msgLower.includes('morning protocol')) {
        const topic = msg.replace(/פרוטוקול|protocol|שגרת בוקר|morning protocol/gi, '').trim() || 'morning longevity protocol';
        reply = await getBiohackingProtocol(topic, lang);

      // ===== תוכנית אישית =====
      } else if (
        msgLower.includes('התוכנית שלי') || msgLower.includes('my plan') ||
        msgLower.includes('תראה לי את התוכנית') || msgLower.includes('show my plan') ||
        msgLower.includes('הפרוטוקול שלי') || msgLower.includes('my protocol')
      ) {
        reply = await getPersonalPlan(user, lang);

      // ===== בנה לי תוכנית =====
      } else if (
        msgLower.includes('בנה לי תוכנית') || msgLower.includes('build my plan') ||
        msgLower.includes('תבנה תוכנית') || msgLower.includes('create my plan') ||
        msgLower.includes('תוכנית אישית') || msgLower.includes('personal plan') ||
        msgLower.includes('פרוטוקול אישי') || msgLower.includes('personal protocol')
      ) {
        await sendWhatsApp(userId, isHeb ? `🧬 מנתח את הנתונים שלך ובונה פרוטוקול אישי... ⏳` : `🧬 Analyzing your data and building personal protocol... ⏳`);
        reply = await buildPersonalPlan(user, lang);

      // ===== הוסף לתוכנית =====
      } else if (
        (msgLower.includes('הוסף') || msgLower.includes('תוסיף') || msgLower.includes('add') || msgLower.includes('include')) &&
        (msgLower.includes('תוכנית') || msgLower.includes('plan') || msgLower.includes('תוסף') || msgLower.includes('supplement') || msgLower.includes('פרוטוקול') || msgLower.includes('protocol') ||
        user.personalPlan?.supplements?.length > 0)
      ) {
        reply = await addToPersonalPlan(user, msg, lang);

      // ===== טסטוסטרון / הורמונים =====
      } else if (
        msgLower.includes('טסטוסטרון') || msgLower.includes('testosterone') ||
        msgLower.includes('הורמון') || msgLower.includes('hormone') ||
        msgLower.includes('אתגר הורמונ') || msgLower.includes('hormonal challenge') ||
        msgLower.includes('leydig') || msgLower.includes('ליידיג') ||
        msgLower.includes('shbg') || msgLower.includes('libido') || msgLower.includes('חשק מיני') ||
        msgLower.includes('rahit') || msgLower.includes('רהיט') ||
        msgLower.includes('bpa') || msgLower.includes('פתלאט') || msgLower.includes('phthalate') ||
        (msgLower.includes('משבש') && msgLower.includes('הורמונ')) ||
        msgLower.includes('edc') || msgLower.includes('אסטרוגן') || msgLower.includes('estrogen')
      ) {
        const topic = msg.replace(/טסטוסטרון|testosterone|הורמון|hormone|אתגר|challenge/gi, '').trim() || 'testosterone optimization';
        await sendWhatsApp(userId, isHeb ? `🧬 בונה פרוטוקול הורמונלי...` : `🧬 Building hormonal protocol...`);
        reply = await getTestosteroneProtocol(topic, user, lang);

      // ===== שאלון 21 שאלות הורמונלי =====
      } else if (
        msgLower.includes('שאלון') || msgLower.includes('questionnaire') ||
        msgLower.includes('21 שאלות') || msgLower.includes('מצב הורמונלי') ||
        msgLower.includes('hormonal status') || msgLower.includes('hormonal assessment')
      ) {
        reply = isHeb
          ? `🧬 *הערכה הורמונלית מדעית — 21 פרמטרים*

*סולם: 1–5 לכל שאלה*
1 = כמעט אף פעם | 3 = לפעמים | 5 = תמיד / באופן עקבי

*🔋 אנרגיה ומנוע פנימי*
1. עוצמת האנרגיה שלך בבוקר מיד עם ההשכמה?
2. רמת המוטיבציה הפנימית לפעולה לאורך היום?
3. יציבות האנרגיה — בלי נפילות אחר הצהריים?
4. תחושת חיוניות ודינמיות כללית?

*⚡ ביצועים גופניים*
5. תדירות האימונים השבועית שלך?
6. עוצמת המאמץ באימון (אחוז מהמקסימום שלך)?
7. יכולת ההתאוששות לאחר אימון או תקופה עמוסה?
8. כוח ועמידות שרירית בהשוואה לשנה שעברה?

*🧠 תפקוד קוגניטיבי והורמונלי*
9. חדות מחשבה, ריכוז וזיכרון?
10. ביטחון בקבלת החלטות — בלי ספקות מיותרות?
11. עוצמת החשק המיני הטבעי (ללא גירוי חיצוני)?
12. רמת ההתלהבות היומית — יש "ניצוץ"?

*😴 שינה והתאוששות*
13. איכות השינה — שינה עמוקה ורציפה?
14. שינה בחושך מוחלט, ללא מסכים?
15. הטלפון מרוחק ממך בשינה?

*🌿 סביבה וחשיפה לרעלים*
16. הימנעות מכלי פלסטיק (מיקרוגל, בקבוקים, קופסאות)?
17. הימנעות מדאודורנטים ובשמים מסחריים?
18. הימנעות מבגדים סינתטיים (פוליאסטר, ניילון)?

*🥗 תזונה והרגלים*
19. צריכת חלבון איכותי בכל ארוחה?
20. הימנעות ממזון מעובד, סוכר ושמנים תעשייתיים?
21. עקביות בביצוע הרגלים שהחלטת עליהם?

━━━━━━━━━━━━━━━
📊 *טווחי ניקוד (מקסימום 105):*
🔴 21–42 — חוסר איזון הורמונלי משמעותי. המערכת האנדוקרינית דורשת התערבות מיידית.
🟠 43–63 — תת-אופטימלי. ישנם גורמי סטרס ביולוגי שמעכבים את הפוטנציאל.
🟡 64–84 — בסיס סביר עם פוטנציאל לשיפור ניכר. כמה שינויים יעשו הבדל גדול.
🟢 85–105 — מצב הורמונלי אופטימלי. המשך לחזק ולשמור.

שלח את הניקוד הכולל ואבנה לך פרוטוקול מותאם אישית 🎯`
          : `🧬 *Scientific Hormonal Assessment — 21 Parameters*

*Scale: 1–5 per question*
1 = Almost never | 3 = Sometimes | 5 = Always / consistently

*🔋 Energy & Internal Drive*
1. Your energy intensity immediately upon waking?
2. Level of internal motivation to act throughout the day?
3. Energy stability — no afternoon crashes?
4. General vitality and dynamism?

*⚡ Physical Performance*
5. Weekly training frequency?
6. Training intensity (% of your maximum)?
7. Recovery capacity after training or a demanding period?
8. Muscular strength and endurance vs. last year?

*🧠 Cognitive & Hormonal Function*
9. Mental clarity, focus and memory sharpness?
10. Confidence in decision-making — without excessive doubt?
11. Natural libido intensity (without external stimulation)?
12. Daily enthusiasm — is there a "spark"?

*😴 Sleep & Recovery*
13. Sleep quality — deep and uninterrupted?
14. Sleeping in complete darkness, no screens?
15. Phone kept away from you during sleep?

*🌿 Environment & Toxin Exposure*
16. Avoiding plastic containers (microwave, bottles, boxes)?
17. Avoiding commercial deodorants and synthetic fragrances?
18. Avoiding synthetic clothing (polyester, nylon)?

*🥗 Nutrition & Habits*
19. Quality protein at every meal?
20. Avoiding processed food, sugar and industrial oils?
21. Consistency in executing habits you've committed to?

━━━━━━━━━━━━━━━
📊 *Score ranges (max 105):*
🔴 21–42 — Significant hormonal imbalance. The endocrine system requires immediate intervention.
🟠 43–63 — Sub-optimal. Biological stressors are suppressing your potential.
🟡 64–84 — Reasonable baseline with significant improvement potential. A few changes will make a big difference.
🟢 85–105 — Optimal hormonal status. Continue to strengthen and maintain.

Send your total score and I'll build you a personalized protocol 🎯`;

      // ===== ניתוח ניקוד שאלון =====
      } else if (user.history.slice(-4).some(h => h.content && (h.content.includes('שאלון') || h.content.includes('questionnaire') || h.content.includes('21 פרמטרים') || h.content.includes('21 Parameters'))) && /^\d+$/.test(msg.trim()) && parseInt(msg.trim()) >= 21 && parseInt(msg.trim()) <= 105) {
        const score = parseInt(msg.trim());
        const scoreCategory = score <= 42 ? 'critical' : score <= 63 ? 'suboptimal' : score <= 84 ? 'moderate' : 'optimal';
        if (!user.personalPlan) user.personalPlan = { supplements: [], protocols: [], goals: [], restrictions: [], lastUpdated: null, hormonalScore: null, hormonalScoreDate: null };
        user.personalPlan.hormonalScore = score;
        user.personalPlan.hormonalScoreDate = new Date().toLocaleDateString();
        reply = await callClaude([{ role: 'user', content: `Max v4. User completed scientific 21-parameter hormonal assessment.
Score: ${score}/105 — Category: ${scoreCategory}
${buildUserContext(user)}

Provide a detailed, science-based analysis:
📊 *Score Analysis:* What this score means biologically (HPA axis, Leydig cells, cortisol/testosterone ratio)
🔍 *Key Deficiencies Identified:* Top 3 areas dragging the score down
🎯 *Personalized Action Plan:*
  Priority 1 (this week): [most impactful single change]
  Priority 2 (this month): [protocol to implement]
  Priority 3 (ongoing): [long-term habit]
💊 *Recommended Supplement Stack* (from approved list only — Magnesium, Zinc+Copper, D3+K2, Boron cycling, Tongkat Ali, Ashwagandha KSM-66, Omega-3, Creatine, B6 P5P)
🏋️ *RAHIT Protocol recommendation* based on score
⚕️ Medical disclaimer
Respond in: ${lang}` }], null, 900);

      // ===== ביוהאקרים מפורסמים =====
      } else if (['huberman', 'attia', 'sinclair', 'johnson', 'rhonda', 'patrick', 'greenfield', 'wim hof'].some(n => msgLower.includes(n))) {
        reply = await callClaude([{ role: 'user', content: `Max v4. Explain key biohacking protocols of the person mentioned in: "${msg}". Top 5 practices + science + implementation. Practical. Respond in: ${lang}` }], null, 800);

      // ===== בדיקת דם =====
      } else if (msgLower.includes('בדיקת דם') || msgLower.includes('blood test') || msgLower.includes('blood results')) {
        if (msg.length > 60) {
          await sendWhatsApp(userId, isHeb ? `🔬 מנתח...` : `🔬 Analyzing...`);
          reply = await analyzeBloodTest(msg, user.profile, user.medicalHistory, lang);
        } else {
          user.pendingMeal = 'blood_test_photo';
          reply = isHeb
            ? `🔬 2 אפשרויות:\n1️⃣ שלח תמונה של הבדיקה\n2️⃣ הקלד ערכים:\nויטמין D: 18\nB12: 320\nאשתמש בטווחים אופטימליים!`
            : `🔬 2 options:\n1️⃣ Send a photo of results\n2️⃣ Type values:\nVitamin D: 18\nB12: 320\nUsing OPTIMAL ranges!`;
        }

      // ===== YouTube =====
      } else if (msgLower.includes('סרטון') || msgLower.includes('יוטיוב') || msgLower.includes('youtube') || msgLower.includes('video') || msgLower.includes('how to')) {
        const isHealth = ['ויטמין', 'הורמון', 'שינה', 'vitamin', 'hormone', 'sleep', 'biohacking', 'longevity', 'fasting', 'cold', 'sauna'].some(w => msgLower.includes(w));
        const topic = msg.replace(/סרטון|יוטיוב|youtube|על|של|how to|video|about/gi, '').trim() || 'biohacking';
        await sendWhatsApp(userId, isHeb ? `🔍 מחפש...` : `🔍 Searching...`);
        reply = await getYouTubeRecommendations(topic, isHealth ? 'health' : 'exercise');

      // ===== אתגר שבועי =====
      } else if (msgLower.includes('אתגר') && !msgLower.includes('השלמתי') || msgLower.includes('challenge') && !msgLower.includes('complete')) {
        const ch = await generateChallenge(user); user.weeklyChallenge = ch; user.challengeCompleted = false; reply = ch;

      // ===== השלמת אתגר =====
      } else if (msgLower.includes('השלמתי אתגר') || msgLower.includes('סיימתי אתגר') || msgLower.includes('challenge complete') || msgLower.includes('completed challenge')) {
        if (user.weeklyChallenge && !user.challengeCompleted) {
          user.challengeCompleted = true; user.streak += 1;
          reply = await callClaude([{ role: 'user', content: `Max v4 celebrates! ${user.profile?.name || 'User'} completed biohacking challenge! Streak: ${user.streak}. 🎉 Celebrate + 🧬 science why this helps longevity + bonus mini challenge. Respond in: ${lang}` }], null, 200);
        } else {
          reply = isHeb ? `כבר השלמת — אלוף! 🏆 הבא ביום ראשון 💪` : `Already completed — champion! 🏆 Next one Sunday 💪`;
        }

      // ===== תוכנית אימונים =====
      } else if (msgLower.includes('תוכנית אימונים') || msgLower.includes('workout plan') || msgLower.includes('training plan') || msgLower.includes('אימון שבועי')) {
        await sendWhatsApp(userId, isHeb ? `💪 בונה תוכנית + קישורי YouTube לכל תרגיל... 🔥` : `💪 Building plan with YouTube links for every exercise... 🔥`);
        user.workoutPlan = await generateWorkoutPlan(user);
        reply = user.workoutPlan;

      // ===== ציטוט =====
      } else if (msgLower.includes('ציטוט') || msgLower.includes('מוטיבציה') || msgLower.includes('quote') || msgLower.includes('motivation')) {
        reply = await callClaude([{ role: 'user', content: `Max v4. Longevity/performance quote from scientist. 💬 "[quote]" — [name + title]\n🧬 [Why this matters for living longer]. 3 lines. Respond in: ${lang}` }], null, 130);

      // ===== דוח יומי =====
      } else if (msgLower.includes('דוח יומי') || msgLower.includes('daily report')) {
        const report = buildDailyReport(user.todayMeals);
        if (!report) {
          reply = isHeb ? `😅 עוד לא שלחת תמונות אוכל.\n${fitnessBar(user)}\nשלח תמונת אוכל! 📸` : `😅 No food logged.\n${fitnessBar(user)}\nSend a food photo! 📸`;
        } else {
          reply = await callClaude([{ role: 'user', content: `Max v4. Biohacking daily report:\n${report.mealCount} meals | ${report.calories}kcal | P: ${report.protein}g | C: ${report.carbs}g | F: ${report.fat}g | Sugar: ${report.sugar}g\nSteps: ${user.fitnessData?.todaySteps || 0} | Workout: ${user.fitnessData?.todayWorkoutMinutes || 0} min\nAnalyze: anti-inflammatory score, what was optimal, what was inflammatory, deficiencies, longevity score/10. Short! Respond in: ${lang}` }], null, 600);
        }

      // ===== תמונת גוף =====
      } else if (msgLower.includes('תמונת גוף') || msgLower.includes('אחוזי שומן') || msgLower.includes('body photo') || msgLower.includes('body fat')) {
        user.pendingMeal = 'body_photo';
        reply = isHeb ? `💪 שלח תמונה בלי חולצה — אנתח אחוזי שומן + המלצות ביוהאקינג! 📸` : `💪 Send a shirtless photo — body fat % + biohacking recommendations! 📸`;

      // ===== בריא לחלוטין =====
      } else if (msgLower.includes('בריא לחלוטין') || msgLower.includes('perfectly healthy') || msgLower.includes('no conditions')) {
        user.medicalHistory.medicalAsked = true;
        reply = await callClaude([{ role: 'user', content: `Max v4. User is perfectly healthy — celebrate! Now go full biohacking optimization mode. Ask: what's their #1 longevity or performance goal? Energetic! Respond in: ${lang}` }], null, 150);

      // ===== שאלת היסטוריה רפואית =====
      } else if (!user.medicalHistory.medicalAsked && user.history.length >= 8) {
        user.medicalHistory.medicalAsked = true;
        reply = await callClaude([{ role: 'user', content: `Max v4. Ask warmly about medical history. Explain it helps personalize protocols. Ask: conditions, medications, allergies. If none → "perfectly healthy". Note: guide not doctor. Respond in: ${lang}` }], null, 200);

      // ===== תיקון ארוחה =====
      } else if (user.pendingMeal?.data) {
        const cr = await callClaude([{ role: 'user', content: `Max v4. Fix meal: ${JSON.stringify(user.pendingMeal.data)}. Correction: "${msg}". Reply + DATA:{...}. Respond in: ${lang}` }], null, 400);
        const dm = cr.match(/DATA:(\{.*?\})/s);
        if (dm) { try { user.pendingMeal.data = JSON.parse(dm[1]); } catch (e) {} }
        reply = cr.replace(/DATA:\{.*?\}/s, '').trim();

      // ===== שיחה רגילה — Claude מלא =====
      } else {
        await addToHistory(user, 'user', replyContext ? `${replyContext} ${msg}` : msg);
        const { summaryText, recentHistory } = buildContext(user);
        const system = MAX_PERSONALITY + buildStatusContext(user, lang, summaryText);
        let aiReply = await callClaude(recentHistory, system, 1000);
        aiReply = await processAIReply(aiReply, user, msg, lang);
        aiReply += capabilityHint(msg, user);
        reply = aiReply;
        await addToHistory(user, 'assistant', reply);
        if (user.onboardingDay < 3 && user.history.length > 6) {
          user.onboardingDay = Math.min(3, Math.floor(user.history.length / 6) + 1);
        }
      }
    } else {
      reply = isHeb ? `סוג הודעה לא נתמך 😅` : `Message type not supported 😅`;
    }

    if (reply) await sendWhatsApp(userId, reply);
    await saveUser(user);

  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message);
  }
});

// =================== HELPERS ===================
function buildStatusContext(user, lang, summaryText) {
  const plan = user.personalPlan || {};
  return `\n\n${summaryText ? summaryText + '\n\n' : ''}📊 Status:
Name: ${user.profile?.name || '?'} | Age: ${user.profile?.age || '?'} | Streak: ${user.streak} days
Height: ${user.profile?.height || '?'} | Weight: ${user.profile?.weight || '?'} | BMI: ${user.profile?.bmi || '?'}
Goals: ${user.profile?.goals?.join(', ') || 'not set'}
Meals: ${user.todayMeals?.length || 0} | Steps: ${user.fitnessData?.todaySteps || 0} | Workout: ${user.fitnessData?.todayWorkoutMinutes || 0} min
Conditions: ${user.medicalHistory?.conditions?.join(', ') || 'none'} | Medications: ${user.medicalHistory?.medications?.join(', ') || 'none'}
Personal Supplement Plan: ${plan.supplements?.length > 0 ? plan.supplements.join(', ') : 'not set yet'}
Personal Protocols: ${plan.protocols?.length > 0 ? plan.protocols.join(', ') : 'not set yet'}
Hormonal Score: ${plan.hormonalScore ? plan.hormonalScore + '/105' : 'not assessed'}
Language: ${lang} — RESPOND IN THIS LANGUAGE ONLY
IMPORTANT: When user asks to ADD supplements, take their CURRENT personal plan and add to it — do NOT start from scratch.`;
}

async function processAIReply(aiReply, user, originalMsg, lang) {
  // שמירת BMI
  const bmiM = aiReply.match(/\[SAVE_BMI:(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]/);
  if (bmiM) {
    const { bmi, status, waterGoal } = calculateBMI(parseFloat(bmiM[1]), parseFloat(bmiM[2]));
    user.profile = { ...user.profile, height: parseFloat(bmiM[1]), weight: parseFloat(bmiM[2]), bmi, waterGoal };
    aiReply = aiReply.replace(bmiM[0], '').trim() + `\n\n📊 BMI: ${bmi} (${status}) | 💧 ${waterGoal}ml/day`;
  }
  const nameM = aiReply.match(/\[SAVE_NAME:([^\]]+)\]/);
  if (nameM) { user.profile.name = nameM[1].trim(); aiReply = aiReply.replace(nameM[0], '').trim(); }
  const ageM = aiReply.match(/\[SAVE_AGE:(\d+)\]/);
  if (ageM) { user.profile.age = parseInt(ageM[1]); aiReply = aiReply.replace(ageM[0], '').trim(); }

  const isHeb = lang === 'hebrew';
  const msgLower = originalMsg.toLowerCase();

  // אם המשתמש ביקש במפורש קישורים — אל תוסיף כלום (כבר טופל בhandler)
  const explicitlyAskedLinks = msgLower.includes('iherb') || msgLower.includes('איהרב') ||
    msgLower.includes('קישורי קנייה') || msgLower.includes('shopping links') || msgLower.includes('לקנות');

  const talkingAboutSupplements = ['תוסף', 'ויטמין', 'מגנזיום', 'supplement', 'vitamin', 'magnesium',
    'omega', 'nmn', 'creatine', 'zinc', 'boron', 'curcumin', 'כורכומין', 'tongkat', 'אשווגנדה', 'ashwagandha'
  ].some(w => msgLower.includes(w) || aiReply.toLowerCase().includes(w));

  // הוסף disclaimer על ויטמינים — תמיד, בלי קישורים אוטומטיים
  if (talkingAboutSupplements && !aiReply.includes('לא רופא') && !aiReply.includes('not a doctor')) {
    aiReply += isHeb
      ? `\n\n⚕️ תזכורת: אני לא רופא — המידע הוא בגדר המלצה בלבד. התייעץ עם רופא לפני שינוי תוספים.`
      : `\n\n⚕️ Reminder: I am not a doctor — all info is for educational purposes only. Consult your doctor before changing supplements.`;
  }

  // הצע קישורים רק אם לא ביקשו אותם כבר ולא קיימים בתשובה
  if (talkingAboutSupplements && !explicitlyAskedLinks && !aiReply.includes('iherb.com')) {
    aiReply += isHeb
      ? `\n\n💡 רוצה קישורי קנייה ל-iHerb? כתוב "קישורי קנייה"`
      : `\n\n💡 Want iHerb shopping links? Say "shopping links"`;
  }

  return aiReply;
}

app.get('/', (req, res) => res.json({ status: 'Max v4.0 🚀', mongodb: !!usersCollection, youtube: !!YOUTUBE_API_KEY, whisper: !!OPENAI_API_KEY }));

connectDB().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log('Max v4.0 running!');
    console.log('MongoDB:', !!MONGODB_URI);
    console.log('YouTube API:', !!YOUTUBE_API_KEY);
    console.log('Whisper (OpenAI):', !!OPENAI_API_KEY);
    console.log('WhatsApp:', !!WA_TOKEN, '- v4.0');
  });
});
