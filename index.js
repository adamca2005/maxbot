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
    proactive: { lastRandomMessage: null, randomMessageCount: 0 }
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
      const summary = await callClaude([{ role: 'user', content: `Summarize in 5 sentences. Keep: goals, health data, achievements, biohacking protocols discussed. Third person.\n\n${text}` }], null, 300);
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

function detectLanguage(text) {
  if (/[\u0590-\u05FF]/.test(text)) return 'hebrew';
  if (/[\u0600-\u06FF]/.test(text)) return 'arabic';
  if (/[áéíóúüñ¿¡]/i.test(text)) return 'spanish';
  if (/[àâäéèêëïîôùûüÿç]/i.test(text)) return 'french';
  if (/[äöüß]/i.test(text)) return 'german';
  return 'english';
}

// =================== MAX v3.0 PERSONALITY + BIOHACKING KNOWLEDGE BASE ===================
const MAX_PERSONALITY = `You are "Max" — the world's most advanced personal biohacking coach on WhatsApp. Your mission: help people live longer, healthier, and perform at their absolute peak. You combine cutting-edge science with practical daily habits.

🌍 LANGUAGE RULE — CRITICAL:
ALWAYS respond in the EXACT same language the user writes in. Never switch languages unless the user does first.

🧬 WHO YOU ARE:
You are inspired by and trained on the protocols of the world's leading biohackers and longevity scientists:
- Bryan Johnson (Blueprint Protocol — most measured human on earth)
- Andrew Huberman (Stanford neuroscientist — sleep, light, hormones)
- Peter Attia (MD focused on longevity medicine)
- David Sinclair (Harvard — NAD+, sirtuins, epigenetic aging)
- Rhonda Patrick (micronutrients, heat shock proteins, omega-3)
- Ben Greenfield (comprehensive biohacking protocols)
- Wim Hof (breathwork, cold exposure)

🎯 YOUR CORE MISSION:
Help humans live to 120+ in peak health. Every recommendation should serve this goal.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔬 BIOHACKING KNOWLEDGE BASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 PROVEN SUPPLEMENTS (evidence-based):
LONGEVITY STACK:
• NMN (500-1000mg/morning) — NAD+ precursor, cellular energy, DNA repair [Sinclair]
• Resveratrol (500mg with fat) — activates sirtuins, anti-aging [Sinclair]
• Metformin (prescription) — mTOR inhibition, longevity [Attia - controversial]
• Rapamycin (low dose cycling) — mTOR inhibitor [Attia - prescription only]

DAILY ESSENTIALS:
• Magnesium Glycinate (300-400mg/night) — sleep, muscle, 300+ enzymes
• Vitamin D3 (2000-5000 IU/morning with K2) — immune, hormone, bone
• Vitamin K2 MK-7 (100-200mcg with D3) — calcium routing
• Omega-3 EPA+DHA (2-4g/day) — inflammation, brain, heart [Rhonda Patrick]
• Zinc (15-30mg) — testosterone, immune, sleep
• Magnesium L-Threonate (evening) — crosses blood-brain barrier, memory

PERFORMANCE:
• Creatine Monohydrate (5g/day) — muscle, brain, energy [most studied supplement]
• L-Citrulline (6-8g pre-workout) — nitric oxide, blood flow
• Beta-Alanine (3.2g) — endurance, lactic acid buffer
• Ashwagandha (600mg KSM-66) — cortisol reduction, testosterone
• Lion's Mane (500-1000mg) — BDNF, neurogenesis, cognitive function

COGNITIVE:
• Alpha-GPC (300mg) — acetylcholine, focus
• Bacopa Monnieri (300mg) — memory consolidation
• L-Theanine + Caffeine (200mg + 100mg) — calm focus
• Phosphatidylserine (100mg) — cortisol control, memory

⚠️ DANGEROUS COMBINATIONS TO AVOID:
• Blood thinners + high dose fish oil + vitamin E = bleeding risk
• Calcium + Magnesium (compete for absorption — take separately)
• Iron + Calcium (block iron absorption)
• St. John's Wort + any medication (cytochrome P450 interaction)
• High dose Vitamin A + pregnancy = teratogenic
• Niacin + statins = myopathy risk
• Melatonin (high dose >1mg) = disrupts natural production

🥗 ANTI-INFLAMMATORY FOODS (eat more):
TIER 1 — Daily:
• Wild salmon (omega-3, astaxanthin)
• Extra virgin olive oil (oleocanthal = natural ibuprofen)
• Blueberries/berries (anthocyanins, resveratrol)
• Broccoli/cruciferous (sulforaphane — NRF2 activation)
• Turmeric + black pepper (curcumin bioavailability 2000%)
• Ginger (gingerol — COX-2 inhibitor)
• Green tea (EGCG — senolytic, antioxidant)
• Walnuts (ALA, polyphenols)
• Dark leafy greens (folate, magnesium, nitrates)
• Garlic (allicin — immune, cardiovascular)

TIER 2 — Weekly:
• Sardines/mackerel (omega-3, CoQ10)
• Avocado (glutathione precursor, healthy fats)
• Sweet potato (beta-carotene, resistant starch)
• Fermented foods: kefir, kimchi, sauerkraut (microbiome)
• Pomegranate (urolithin A — mitophagy, muscle)
• Dark chocolate 85%+ (flavonoids, magnesium)

🚫 FOODS THAT ACCELERATE AGING (avoid):
BLOOD SUGAR DESTROYERS:
• Refined sugar (glucose spikes → AGEs → collagen damage)
• White bread, white rice, pasta (glycemic spike)
• Fruit juices (fructose without fiber)
• Breakfast cereals (hidden sugar)
• Energy drinks (sugar + caffeine stress)

INFLAMMATORY FOODS:
• Seed oils: canola, soybean, corn, sunflower (omega-6 excess → arachidonic acid cascade)
• Processed meats: hot dogs, deli meat (nitrosamines, AGEs)
• Trans fats (partially hydrogenated oils)
• Ultra-processed foods (emulsifiers → gut permeability)
• Alcohol excess (acetaldehyde → DNA damage, mitochondrial dysfunction)
• Gluten (for sensitive individuals → zonulin → leaky gut)
• Artificial sweeteners (aspartame, sucralose → gut microbiome disruption)
• Fried foods at high temp (acrylamide, oxidized fats)

🌞 LIGHT & CIRCADIAN OPTIMIZATION:
MORNING PROTOCOL (first 30-60 min):
• Get outside within 30min of waking — 10-30min sunlight exposure
• No sunglasses for first morning light (melanopsin in eyes needs unfiltered light)
• This sets cortisol awakening response (CAR) — natural energy spike
• Anchors circadian rhythm → better sleep that night [Huberman]

EVENING PROTOCOL:
• Avoid bright overhead lights after sunset
• Use warm/dim lighting (2700K or lower)
• Blue light blocking glasses 2-3hrs before bed
• No screens 1hr before sleep (or use Night Shift + minimum brightness)
• Blackout curtains — even small light exposure suppresses melatonin 50%

LIGHT TIMING:
• Morning sun → cortisol peak (energy, alertness)
• Afternoon sun (solar noon ± 2hrs) → vitamin D synthesis
• Evening dim → melatonin rise → sleep onset

❄️ COLD EXPOSURE PROTOCOLS:
COLD SHOWER (beginner):
• End shower with 30-60 sec cold
• Progressively increase to 3-5 min cold
• Benefits: norepinephrine +300%, brown fat activation, dopamine +250%

ICE BATH (advanced):
• 10-15°C (50-59°F) water
• 2-4 minutes 3-4x/week
• Timing: NOT immediately after strength training (blunts hypertrophy)
• Best: morning, or 6+ hours after training

MECHANISM: Activates norepinephrine → focus, mood, metabolism
[Wim Hof, Huberman protocols]

🔥 SAUNA PROTOCOLS:
• 80-100°C, 15-20 minutes
• 4-7x/week for maximum longevity benefit [Rhonda Patrick — Finnish studies]
• Benefits: heat shock proteins, growth hormone 2x, cardiovascular
• Contrast therapy: sauna → cold plunge → sauna = maximum hormetic stress

😴 SLEEP OPTIMIZATION:
ENVIRONMENT:
• Temperature: 65-68°F (18-20°C) — core body temp must drop 1-2°C
• Complete darkness (blackout curtains, tape over LEDs)
• White noise or silence
• No phones in bedroom

TIMING:
• Consistent wake time (even weekends) — most important factor
• Sleep 7-9 hours (less = accelerated aging, more = sign of poor sleep quality)
• Naps: 10-20 min before 3pm only (longer = sleep inertia)

SUPPLEMENTS FOR SLEEP:
• Magnesium Glycinate (300mg, 30min before bed)
• L-Theanine (200mg) — calming without sedation
• Glycine (3g) — lowers core body temp, improves sleep quality
• Apigenin (50mg, in chamomile) — GABA-A modulation [Huberman protocol]
• Melatonin (0.1-0.3mg only if needed) — dose matters, less is more

🏃 EXERCISE SCIENCE:
ZONE 2 CARDIO (longevity foundation):
• 150-200 min/week at conversational pace
• Benefits: mitochondrial biogenesis, metabolic flexibility, VO2max
• Most important exercise for longevity [Peter Attia]

STRENGTH TRAINING:
• Progressive overload 3-4x/week
• Compound movements: squat, deadlift, press, pull
• Maintain muscle mass = strongest predictor of longevity after 40

VO2 MAX TRAINING:
• 1-2x/week high intensity intervals
• 4 min hard (zone 4-5) × 4 rounds = Norwegian 4×4 protocol
• VO2max is single best predictor of longevity

GRIP STRENGTH:
• Strong predictor of all-cause mortality
• Train: dead hangs, farmer carries, rock climbing

🧠 COGNITIVE ENHANCEMENT:
• Learn something new daily (neuroplasticity)
• Cold exposure → BDNF (brain-derived neurotrophic factor)
• Exercise → BDNF (most powerful brain growth signal)
• Fasting → autophagy → brain cleaning
• Sleep → glymphatic system clears amyloid plaques
• Meditation → reduces amygdala reactivity, grows prefrontal cortex

⚡ FASTING PROTOCOLS:
16:8 INTERMITTENT FASTING (most practical):
• 16 hours fasting / 8 hour eating window
• Benefits: insulin sensitivity, autophagy initiation, weight loss
• Break fast with protein + fat (not carbs)

EXTENDED FASTING (advanced):
• 24-72 hours periodic
• Triggers deep autophagy, stem cell regeneration
• Requires medical supervision

TIME-RESTRICTED EATING:
• Align eating with daylight hours
• Stop eating 3 hours before sleep (prevents glucose spike during sleep)
• First meal: within 1-2 hours of waking (cortisol + insulin synergy)

🩺 BIOMARKERS TO TRACK:
ESSENTIAL:
• Fasting glucose (< 85 optimal)
• HbA1c (< 5.3% optimal)
• Fasting insulin (< 5 uIU/mL optimal)
• Vitamin D (50-80 ng/mL optimal)
• hs-CRP (< 0.5 mg/L optimal — inflammation)
• Homocysteine (< 7 μmol/L optimal)
• Ferritin (men: 30-100, women: 20-80)
• B12 (> 500 pg/mL optimal)
• Testosterone total + free
• TSH, Free T3, Free T4

ADVANCED:
• ApoB (< 60 mg/dL optimal — cardiovascular risk)
• Lp(a) (< 30 mg/dL)
• IGF-1 (age-dependent optimal range)
• DHEA-S
• RBC Magnesium (more accurate than serum)

💊 BRYAN JOHNSON BLUEPRINT HIGHLIGHTS:
• Wakes 5am, eats within 1-hour window (breakfast only)
• ~1977 calories/day, plant-based + fish
• 111 supplements daily
• Sleeps at 8:30pm consistently
• Measures everything: continuous glucose monitor, sleep tracker, HRV
• Key supplements: NMN, Resveratrol, Metformin, Lithium, CoQ10, Lycopene
• Exercise: 1 hour daily, mix of strength + zone 2
• No alcohol, no smoking, minimal processed food

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 ONBOARDING PROTOCOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Day 1: name, age, main goals, daily routine, height, weight
Day 2: current nutrition, sleep hours, activity level, stress, supplements
Day 3: what hasn't worked, obstacles, available time, any health conditions

📌 When user gives height+weight → [SAVE_BMI:height:weight]
📌 When user gives name → [SAVE_NAME:name]
📌 When user gives age → [SAVE_AGE:age]

🧠 CONTEXT RULES — CRITICAL:
- NEVER assume someone worked out unless they EXPLICITLY say "I worked out/trained/ran/exercised"
- Questions like "can you give me a workout" are NOT reports of exercise
- "I have a gym nearby" = ACCESS, not activity
- Only update fitness stats on explicit past-tense completion reports
- Always use conversation history to give personalized advice

💡 CAPABILITY HINTS — show only when contextually relevant, one at a time:
- Fatigue/energy issues → mention blood test analysis
- Exercise questions → mention YouTube links for exercises
- Food discussion → mention food photo analysis
- Aging/longevity → expand on biohacking protocols

💪 COMMUNICATION STYLE:
- Max 5 lines per message, emojis, one question at end
- Direct, energetic, science-backed
- Always connect advice to longevity ("this will add years to your life")
- First message: energetic greeting + ask name!
- NEVER recommend specific prescription medications
- Always add "consult your doctor before starting supplements"`;

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

async function downloadMedia(mediaId) {
  const mediaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  const fileRes = await axios.get(mediaRes.data.url, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  return { base64: Buffer.from(fileRes.data).toString('base64'), mimeType: mediaRes.data.mime_type || 'image/jpeg' };
}

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

// =================== FITNESS — STRICT PARSING (BUG FIXED) ===================
function parseFitness(msg, user) {
  const msgLower = msg.toLowerCase();

  // זיהוי שאלות — לא לעדכן כושר אם זו שאלה!
  const isQuestion =
    msgLower.includes('?') ||
    msgLower.includes('תביא') ||
    msgLower.includes('יכול') ||
    msgLower.includes('תוכל') ||
    msgLower.includes('can you') ||
    msgLower.includes('could you') ||
    msgLower.includes('give me') ||
    msgLower.includes('show me') ||
    msgLower.includes('תראה') ||
    msgLower.includes('תן לי');

  if (isQuestion) return false;

  // רק דיווח מפורש בעבר
  const explicitWorkoutPhrases = [
    'עשיתי אימון', 'סיימתי אימון', 'התאמנתי', 'רצתי', 'שחיתי', 'עשיתי כושר',
    'הלכתי לחדר כושר', 'עשיתי יוגה', 'עשיתי אופניים',
    'i worked out', 'i trained', 'i ran', 'i exercised', 'i swam',
    'finished workout', 'completed workout', 'just finished', 'went to the gym',
    'just ran', 'just trained', 'did a workout'
  ];

  const steps = msg.match(/(\d[\d,]*)\s*(?:צעדים|steps)/i);
  const isExplicitWorkout = !isQuestion && explicitWorkoutPhrases.some(p => msgLower.includes(p));
  let updated = false;

  if (steps) {
    user.fitnessData.todaySteps = parseInt(steps[1].replace(',', ''));
    updated = true;
  }

  if (isExplicitWorkout) {
    const minutes = msg.match(/(\d+)\s*(?:דק|דקות|min|minutes)/i);
    user.fitnessData.todayWorkoutMinutes += minutes ? parseInt(minutes[1]) : 45;
    const workoutType = msg.match(/(?:ריצה|הליכה|שחייה|יוגה|אופניים|כוח|running|swimming|cycling|yoga|strength)/i);
    if (workoutType) user.fitnessData.todayWorkoutType = workoutType[0];
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
    content: `Give 3 YouTube search queries in ENGLISH for: "${topic}" (${type === 'health' ? 'biohacking/health science/longevity' : 'exercise/workout/fitness'}). One per line. No numbers.`
  }], null, 100);

  const queries = queriesText.trim().split('\n').filter(q => q.trim()).slice(0, 3);
  let msg = `${type === 'health' ? '🎓' : '🎬'} YouTube videos about "${topic}":\n\n`;

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

// =================== WORKOUT PLAN WITH YOUTUBE ===================
async function generateWorkoutPlan(user) {
  const lang = user.profile?.language || 'english';
  const plan = await callClaude([{
    role: 'user',
    content: `You are Max. Create a science-based weekly workout plan for longevity and performance.
Profile: ${user.profile?.height || '?'}cm | ${user.profile?.weight || '?'}kg | age ${user.profile?.age || '?'}
Limitations: ${user.medicalHistory?.conditions?.join(', ') || 'none'}
Goals: ${user.profile?.goals?.join(', ') || 'general health'}

Include Zone 2 cardio, strength training, and mobility. Based on Peter Attia longevity principles.

Format:
💪 YOUR WEEKLY PLAN:

📅 Day 1 — [name]:
• [Exercise]: X sets × X reps — YOUTUBE:[exercise name english]
[3-4 exercises per day]

[All 7 days]

⏱️ ~X min/day | 🧬 Longevity tip: [one science-based tip]
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

// =================== BIOHACKING PROTOCOLS ===================
async function getBiohackingProtocol(topic, lang) {
  return await callClaude([{
    role: 'user',
    content: `You are Max — world's top biohacking coach. Give a detailed, science-based protocol for: "${topic}".

Include:
- The science behind it (mechanism)
- Specific protocol (dosage/timing/duration)
- Who pioneered it (Huberman/Attia/Sinclair/Johnson etc.)
- Expected timeline for results
- Any warnings or contraindications
- YouTube search to learn more

Be specific, practical, and cite the science. Respond in: ${lang}`
  }], null, 800);
}

async function getSupplementStack(goal, user, lang) {
  const age = user.profile?.age || 'unknown';
  const conditions = user.medicalHistory?.conditions?.join(', ') || 'none';
  return await callClaude([{
    role: 'user',
    content: `You are Max — biohacking supplement expert. Recommend a supplement stack for: "${goal}".
User age: ${age}, conditions: ${conditions}

Include for each supplement:
- Name + dose + timing
- Mechanism (why it works)
- Evidence level (strong/moderate/emerging)
- Sourced from which biohacker protocol

Format clearly. Add: ⚠️ Always consult doctor before starting.
Note dangerous combinations to avoid.
Respond in: ${lang}`
  }], null, 800);
}

async function getAntiInflammatoryPlan(lang) {
  return await callClaude([{
    role: 'user',
    content: `You are Max. Create a practical anti-inflammatory eating guide.

Include:
🟢 EAT DAILY: [top 10 foods + why]
🟡 EAT WEEKLY: [top 5 foods]
🔴 AVOID COMPLETELY: [top 10 inflammatory foods + mechanism]
⚡ QUICK WIN: One change to make today

Science-based, practical, specific. Respond in: ${lang}`
  }], null, 600);
}

// =================== WEEKLY CHALLENGE ===================
async function generateChallenge(user) {
  const lang = user.profile?.language || 'english';
  return await callClaude([{
    role: 'user',
    content: `Max. Create a biohacking weekly challenge. Profile: ${user.profile?.height || '?'}cm, ${user.profile?.weight || '?'}kg, streak ${user.streak} days.
🏆 Challenge: [biohacking-based name]
📋 Mission: [specific and measurable]
🧬 Science: [why this extends healthspan]
🎯 Success: [clear metric]
💡 Tip: [practical advice]
Reply "challenge complete" when done 🎉 Respond in: ${lang}`
  }], null, 400);
}

// =================== BLOOD TEST ANALYSIS ===================
async function analyzeBloodTest(data, profile, med, lang) {
  return await callClaude([{
    role: 'user',
    content: `You are Max — functional medicine health guide. Analyze blood test with OPTIMAL ranges (not just normal ranges).
Profile: age ${profile.age || '?'}, ${profile.height || '?'}cm, ${profile.weight || '?'}kg
Conditions: ${med.conditions?.join(', ') || 'none'} | Medications: ${med.medications?.join(', ') || 'none'}

Results: ${data}

Use OPTIMAL ranges (e.g. Vitamin D optimal = 50-80 ng/mL, not just "normal"):
✅ Optimal range
⚡ Suboptimal (normal but not optimal)
⚠️ Borderline — attention needed
🚨 Abnormal — see doctor immediately

💊 Deficiencies identified + food sources + supplement recommendations
🔗 Patterns that suggest underlying issues
🥗 Top 3 dietary changes based on results
⚕️ Always consult your doctor for medical decisions

Respond in: ${lang}`
  }], null, 1500);
}

// =================== PROACTIVE MESSAGES ===================
async function randomProactive(user) {
  const name = user.profile?.name || '';
  const lang = user.profile?.language || 'english';
  const lastSummary = user.summaryHistory?.slice(-1)[0]?.summary || '';

  const topics = [
    'cold exposure and dopamine/norepinephrine',
    'Zone 2 cardio and mitochondrial biogenesis',
    'NAD+ decline with age and NMN supplementation',
    'circadian rhythm optimization and cortisol',
    'gut microbiome and brain-gut axis',
    'sauna heat shock proteins and longevity',
    'Wim Hof breathwork and stress resilience',
    'blood glucose management and aging',
    'sleep and glymphatic brain cleaning',
    'VO2 max as longevity predictor',
    'intermittent fasting and autophagy',
    'omega-3 and inflammation resolution',
    'magnesium deficiency and 300+ enzymes',
    'grip strength and all-cause mortality',
    'red light therapy and mitochondria',
    'hormesis — stress that makes you stronger',
    'Bryan Johnson Blueprint protocol',
    'David Sinclair information theory of aging',
    'Andrew Huberman morning protocol',
    'Peter Attia centenarian decathlon'
  ];

  const topic = topics[Math.floor(Math.random() * topics.length)];

  const types = [
    () => callClaude([{ role: 'user', content: `Max. Surprising biohacking insight about: "${topic}". ${name ? `User: ${name}.` : ''} ${lastSummary ? `Context: ${lastSummary}` : ''} 🧬 [Surprising fact + mechanism] + practical action for TODAY + one question. Max 4 lines. Respond in: ${lang}` }], null, 150),
    () => callClaude([{ role: 'user', content: `Max. Share a longevity science fact that most people don't know. Connect to something actionable. 🔬 [Fact] + why it matters for living longer + question. Max 3 lines. Respond in: ${lang}` }], null, 130),
    () => callClaude([{ role: 'user', content: `Max. Personal spontaneous message to ${name || 'user'}. ${lastSummary ? `Based on: ${lastSummary}` : ''} Streak: ${user.streak}. Feel like a coach who just thought of something. Warm, direct, biohacking-related. 3 lines + question. Respond in: ${lang}` }], null, 130),
    () => callClaude([{ role: 'user', content: `Max. Mini biohacking challenge for next 24 hours. Simple, measurable, science-backed. ⚡ Challenge: [specific action] + mechanism + "will you try it?" Max 3 lines. Respond in: ${lang}` }], null, 120),
    () => callClaude([{ role: 'user', content: `Max. Share one protocol from Bryan Johnson, Andrew Huberman, Peter Attia, or David Sinclair. Credit the source. 👨‍🔬 [Name] says: [protocol] + why it works + question. Max 3 lines. Respond in: ${lang}` }], null, 130),
  ];

  return await types[Math.floor(Math.random() * types.length)]();
}

// =================== CAPABILITY HINTS ===================
function capabilityHint(msg, user) {
  const shown = user.shownCapabilities || [];
  const m = msg.toLowerCase();
  const lang = user.profile?.language || 'english';
  const isHeb = lang === 'hebrew';

  const caps = [
    { id: 'blood_test', triggers: ['tired', 'fatigue', 'energy', 'hair loss', 'עייפות', 'אנרגיה', 'שיער', 'חלש'], hint: isHeb ? `\n\n🔬 אגב — אני יכול לנתח בדיקות דם ולזהות חוסרים לפי רמות אופטימליות, לא רק נורמליות!` : `\n\n🔬 By the way — I can analyze blood tests using OPTIMAL ranges, not just normal ranges!` },
    { id: 'youtube', triggers: ['exercise', 'workout', 'how to', 'תרגיל', 'איך'], hint: isHeb ? `\n\n🎬 אגב — כל תוכנית אימונים שאני בונה כוללת קישורי YouTube לכל תרגיל!` : `\n\n🎬 By the way — every workout plan I create includes YouTube links for every exercise!` },
    { id: 'food_photo', triggers: ['ate', 'eating', 'calories', 'אכלתי', 'קלוריות'], hint: isHeb ? `\n\n📸 אגב — שלח תמונת אוכל ואנתח קלוריות, מינרלים וציון אנטי-דלקתי!` : `\n\n📸 By the way — send a food photo and I'll analyze calories, minerals AND anti-inflammatory score!` },
    { id: 'supplements', triggers: ['supplement', 'vitamin', 'תוסף', 'ויטמין', 'מגנזיום'], hint: isHeb ? `\n\n💊 אגב — אני יכול לבנות לך stack תוספים מותאם אישית לפי הפרופיל שלך!` : `\n\n💊 By the way — I can build you a personalized supplement stack based on your profile!` },
    { id: 'longevity', triggers: ['aging', 'longevity', 'live longer', 'הזדקנות', 'אריכות', 'לחיות יותר'], hint: isHeb ? `\n\n🧬 אגב — אני יכול לתת לך פרוטוקול מלא לאריכות חיים מבוסס מדע!` : `\n\n🧬 By the way — I can give you a complete science-based longevity protocol!` }
  ];

  for (const cap of caps) {
    if (!shown.includes(cap.id) && cap.triggers.some(t => m.includes(t))) {
      user.shownCapabilities.push(cap.id);
      return cap.hint;
    }
  }
  return '';
}

// =================== ALL USERS HELPER ===================
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
      const q = await callClaude([{ role: 'user', content: `Max. Morning biohacking quote + protocol reminder. ${user.profile?.name ? `Name: ${user.profile.name}.` : ''} Streak: ${user.streak || 0} days.\n🌅 Good morning! 💬 "[longevity/performance quote]" — [scientist/biohacker]\n🧬 Today's protocol: [one specific actionable biohacking tip]\nWhat's your plan? 💪 Respond in: ${lang}` }], null, 170);
      await sendWhatsApp(user.userId, q);
    } catch (e) { console.error('Morning quote error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 13 * * *', async () => {
  const users = await getActiveUsers(24);
  for (const user of users) {
    try {
      const lang = user.profile?.language || 'english';
      const tip = await callClaude([{ role: 'user', content: `Max. Midday biohacking tip about energy or focus. Science-based, 1 sentence. Respond in: ${lang}` }], null, 80);
      const isHeb = lang === 'hebrew';
      const msg = isHeb
        ? `⚡ עדכון צהריים!\n${user.todayMeals?.length > 0 ? `🍽️ ${user.todayMeals.length} ארוחות מתועדות` : '📸 עוד לא תיעדת ארוחה!'}\n${user.fitnessData?.todaySteps > 0 ? `👟 ${user.fitnessData.todaySteps.toLocaleString()} צעדים` : '👟 דווח על צעדים!'}\n\n🧬 ${tip}`
        : `⚡ Midday check-in!\n${user.todayMeals?.length > 0 ? `🍽️ ${user.todayMeals.length} meals logged` : '📸 No meals logged!'}\n${user.fitnessData?.todaySteps > 0 ? `👟 ${user.fitnessData.todaySteps.toLocaleString()} steps` : '👟 Log your steps!'}\n\n🧬 ${tip}`;
      await sendWhatsApp(user.userId, msg);
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
        ? `🌙 סיכום יום!\n${icon} צעדים: ${(fd.todaySteps || 0).toLocaleString()}/${goal.toLocaleString()}\n💪 אימון: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} דקות` : 'לא דווח'}\n🍽️ ארוחות: ${user.todayMeals?.length || 0} | 🔥 רצף: ${user.streak || 0} ימים\n😴 ${sleepTip}\nשלח "דוח יומי" לסיכום 📊`
        : `🌙 Daily summary!\n${icon} Steps: ${(fd.todaySteps || 0).toLocaleString()}/${goal.toLocaleString()}\n💪 Workout: ${fd.todayWorkoutMinutes > 0 ? `${fd.todayWorkoutMinutes} min` : 'Not logged'}\n🍽️ Meals: ${user.todayMeals?.length || 0} | 🔥 Streak: ${user.streak || 0} days\n😴 ${sleepTip}\nSend "daily report" for full summary 📊`;
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
        const msg = await randomProactive(user);
        await sendWhatsApp(user.userId, msg);
        if (!user.proactive) user.proactive = {};
        user.proactive.lastRandomMessage = new Date();
        user.proactive.randomMessageCount = (user.proactive.randomMessageCount || 0) + 1;
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
    const lang = user.profile?.language || 'english';
    const msgs = lang === 'hebrew'
      ? [`💧 זמן לשתות! מטרה: ${goal}ml — מים = ביצועים 🙏`, `💦 הידרציה = קוגניציה + אנרגיה 💪`, `🌊 שתה עכשיו! ${goal}ml ביום 🎯`]
      : [`💧 Hydration time! Goal: ${goal}ml — water = performance 🙏`, `💦 Hydration = cognition + energy 💪`, `🌊 Drink now! ${goal}ml/day 🎯`];
    try { await sendWhatsApp(user.userId, msgs[Math.floor(Math.random() * msgs.length)]); }
    catch (e) { console.error('Water error:', e.message); }
  }
}, { timezone: 'Asia/Jerusalem' });

// =================== WEBHOOK VERIFY ===================
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else { res.sendStatus(403); }
});

// =================== MAIN WEBHOOK ===================
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

    if (message.type === 'text') {
      const detectedLang = detectLanguage(message.text.body);
      if (!user.profile.language) user.profile.language = detectedLang;
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

    if (message.type === 'audio') {
      reply = isHeb ? `🎤 קיבלתי הודעה קולית! כתוב לי בטקסט ואענה מיד 💪` : `🎤 Got your voice message! Text me and I'll respond right away 💪`;

    } else if (message.type === 'image' && user.pendingMeal === 'body_photo') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      reply = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Max. Analyze body composition. ${user.profile.height || '?'}cm, ${user.profile.weight || '?'}kg, age ${user.profile.age || '?'}.
📊 Estimated body fat % | 💪 Body type (ecto/meso/endo) | 🎯 Areas to improve | ✅ Strengths | 🧬 Biohacking recommendation for body composition
Be encouraging and science-based. Respond in: ${lang}` }
      ]}], null, 600);
      user.pendingMeal = null;

    } else if (message.type === 'image' && user.pendingMeal === 'blood_test_photo') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      await sendWhatsApp(userId, isHeb ? `🔬 מנתח בדיקות דם... רגע!` : `🔬 Analyzing blood test... one moment!`);
      reply = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Max. Read and analyze blood test using OPTIMAL ranges. Age ${user.profile.age || '?'}.
✅ Optimal | ⚡ Suboptimal | ⚠️ Borderline | 🚨 Abnormal
💊 Deficiencies + supplements | 🔗 Patterns | 🥗 Top 3 dietary changes | ⚕️ See doctor disclaimer
Respond in: ${lang}` }
      ]}], null, 1500);
      user.medicalHistory.lastBloodTest = new Date().toISOString();
      user.pendingMeal = null;

    } else if (message.type === 'image') {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      const full = await callClaude([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Max — nutrition + biohacking coach. Analyze food. Hand = scale reference.
🍽️ What I see | 🔥 Calories | 💪 Protein | 🍞 Carbs | 🍬 Sugar | 🥑 Fat
🧂 Key minerals + vitamins
🧬 Anti-inflammatory score (1-10) + reason
💡 One biohacking nutrition tip
❓ Accurate? Correct or say "save"
DATA:{"calories":0,"protein":0,"carbs":0,"fat":0,"sugar":0,"minerals":{"iron":0,"calcium":0,"potassium":0,"magnesium":0,"sodium":0,"zinc":0,"vitC":0,"vitD":0,"vitB12":0}}
Respond in: ${lang}` }
      ]}], null, 1000);
      const dm = full.match(/DATA:(\{.*?\})/s);
      if (dm) { try { user.pendingMeal = { data: JSON.parse(dm[1]), time: new Date().toLocaleTimeString() }; } catch (e) {} }
      reply = full.replace(/DATA:\{.*?\}/s, '').trim();

    } else if (message.type === 'text') {
      const msg = message.text.body.trim();
      const fitnessUpdated = parseFitness(msg, user);
      const msgLower = msg.toLowerCase();

      const saveWords = ['שמור', 'save', 'guardar', 'sauvegarder'];
      const completeWords = ['השלמתי אתגר', 'סיימתי אתגר', 'challenge complete', 'completed challenge'];

      if (saveWords.some(w => msgLower === w)) {
        if (user.pendingMeal?.data) {
          user.todayMeals.push(user.pendingMeal); user.pendingMeal = null;
          reply = isHeb ? `✅ נשמר! ${user.todayMeals.length} ארוחות היום 📊` : `✅ Saved! ${user.todayMeals.length} meals today 📊`;
        } else { reply = isHeb ? `אין ארוחה ממתינה 😅` : `No pending meal 😅`; }

      } else if (msgLower.includes('כושר שלי') || msgLower.includes('my fitness') || msgLower.includes('סטטוס')) {
        reply = fitnessBar(user);

      } else if (fitnessUpdated) {
        reply = await callClaude([{ role: 'user', content: `Max. React to workout report. Steps: ${user.fitnessData.todaySteps}, workout: ${user.fitnessData.todayWorkoutMinutes} min. Add biohacking recovery tip. Short + energetic + question. Respond in: ${lang}` }], null, 170);

      } else if (msgLower.includes('פרוטוקול בוקר') || msgLower.includes('morning protocol') || msgLower.includes('morning routine')) {
        reply = await getBiohackingProtocol('optimal morning protocol for peak performance and longevity', lang);

      } else if (msgLower.includes('תוספים') || msgLower.includes('supplements') || msgLower.includes('stack')) {
        const goal = msg.replace(/תוספים|supplements|stack|מומלצים|recommended/gi, '').trim() || 'general health and longevity';
        reply = await getSupplementStack(goal, user, lang);

      } else if (msgLower.includes('אנטי דלקת') || msgLower.includes('anti-inflammatory') || msgLower.includes('inflammation')) {
        reply = await getAntiInflammatoryPlan(lang);

      } else if (msgLower.includes('פרוטוקול') || msgLower.includes('protocol')) {
        const topic = msg.replace(/פרוטוקול|protocol/gi, '').trim() || 'longevity';
        reply = await getBiohackingProtocol(topic, lang);

      } else if (msgLower.includes('bryan johnson') || msgLower.includes('huberman') || msgLower.includes('peter attia') || msgLower.includes('david sinclair') || msgLower.includes('rhonda patrick')) {
        const person = msg;
        reply = await callClaude([{ role: 'user', content: `Max. Explain the key biohacking protocols of whoever is mentioned in: "${person}". Include their top 5 practices, the science behind each, and how to implement. Practical and actionable. Respond in: ${lang}` }], null, 800);

      } else if (msgLower.includes('בדיקת דם') || msgLower.includes('blood test') || msgLower.includes('blood results')) {
        if (msg.length > 60) {
          await sendWhatsApp(userId, isHeb ? `🔬 מנתח... רגע!` : `🔬 Analyzing... one moment!`);
          reply = await analyzeBloodTest(msg, user.profile, user.medicalHistory, lang);
        } else {
          user.pendingMeal = 'blood_test_photo';
          reply = isHeb
            ? `🔬 2 אפשרויות:\n1️⃣ שלח תמונה של הבדיקה\n2️⃣ הקלד ערכים:\nויטמין D: 18\nB12: 320\nאשתמש בטווחים אופטימליים — לא רק נורמליים!`
            : `🔬 2 options:\n1️⃣ Send a photo of your results\n2️⃣ Type values:\nVitamin D: 18\nB12: 320\nI use OPTIMAL ranges — not just normal!`;
        }

      } else if (msgLower.includes('סרטון') || msgLower.includes('יוטיוב') || msgLower.includes('youtube') || msgLower.includes('video') || msgLower.includes('how to')) {
        const isHealth = ['ויטמין', 'הורמון', 'שינה', 'vitamin', 'hormone', 'sleep', 'biohacking', 'longevity', 'fasting', 'cold', 'sauna'].some(w => msgLower.includes(w));
        const topic = msg.replace(/סרטון|יוטיוב|youtube|על|של|how to|video|about/gi, '').trim() || 'biohacking';
        await sendWhatsApp(userId, isHeb ? `🔍 מחפש ביוטיוב...` : `🔍 Searching YouTube...`);
        reply = await getYouTubeRecommendations(topic, isHealth ? 'health' : 'exercise');

      } else if (completeWords.some(w => msgLower.includes(w))) {
        if (user.weeklyChallenge && !user.challengeCompleted) {
          user.challengeCompleted = true; user.streak += 1;
          reply = await callClaude([{ role: 'user', content: `Max celebrates! ${user.profile?.name || 'User'} completed biohacking challenge! Streak: ${user.streak}. 🎉 Big celebration + 🏆 + 🧬 science fact about why this challenge helps longevity. Short! Respond in: ${lang}` }], null, 200);
        } else {
          reply = isHeb ? `כבר השלמת השבוע — אלוף! 🏆 הבא ביום ראשון 💪` : `Already completed this week — champion! 🏆 Next one Sunday 💪`;
        }

      } else if (msgLower.includes('אתגר שבועי') || msgLower.includes('weekly challenge') || (msgLower.includes('אתגר') && !msgLower.includes('השלמתי'))) {
        const ch = await generateChallenge(user); user.weeklyChallenge = ch; user.challengeCompleted = false; reply = ch;

      } else if (msgLower.includes('תוכנית אימונים') || msgLower.includes('workout plan') || msgLower.includes('training plan') || msgLower.includes('אימון שבועי')) {
        await sendWhatsApp(userId, isHeb ? `💪 בונה תוכנית עם מדע + קישורי YouTube... 🔥` : `💪 Building science-based plan with YouTube links... 🔥`);
        user.workoutPlan = await generateWorkoutPlan(user);
        reply = user.workoutPlan;

      } else if (msgLower.includes('ציטוט') || msgLower.includes('מוטיבציה') || msgLower.includes('quote') || msgLower.includes('motivation')) {
        reply = await callClaude([{ role: 'user', content: `Max. Longevity/performance quote from a scientist or biohacker. Streak: ${user.streak}.\n💬 "[quote]" — [person + credential]\n🧬 [Why this matters for living longer]. 3 lines. Respond in: ${lang}` }], null, 130);

      } else if (msgLower.includes('דוח יומי') || msgLower.includes('daily report')) {
        const report = buildDailyReport(user.todayMeals);
        if (!report) {
          reply = isHeb ? `😅 עוד לא שלחת תמונות אוכל.\n${fitnessBar(user)}\nשלח תמונת אוכל! 📸` : `😅 No food logged.\n${fitnessBar(user)}\nSend a food photo! 📸`;
        } else {
          reply = await callClaude([{ role: 'user', content: `Max. Daily biohacking report:\n${report.mealCount} meals | ${report.calories}kcal | Protein: ${report.protein}g | Carbs: ${report.carbs}g | Fat: ${report.fat}g\n${user.fitnessData?.todaySteps || 0} steps | ${user.fitnessData?.todayWorkoutMinutes || 0} min workout\nMinerals: ${Object.entries(report.minerals || {}).map(([k,v]) => `${k}:${v}`).join(', ')}\nAnalyze: what was optimal, what was inflammatory, what's missing, biohacking recommendations, longevity score/10. Short! Respond in: ${lang}` }], null, 600);
        }

      } else if (msgLower.includes('תמונת גוף') || msgLower.includes('אחוזי שומן') || msgLower.includes('body photo') || msgLower.includes('body fat')) {
        user.pendingMeal = 'body_photo';
        reply = isHeb ? `💪 שלח תמונה בלי חולצה — אנתח אחוזי שומן + המלצות ביוהאקינג אישיות! 📸` : `💪 Send a shirtless photo — I'll analyze body fat + personalized biohacking recommendations! 📸`;

      } else if (msgLower.includes('בריא לחלוטין') || msgLower.includes('perfectly healthy') || msgLower.includes('no conditions')) {
        user.medicalHistory.medicalAsked = true;
        reply = await callClaude([{ role: 'user', content: `Max. User is perfectly healthy. Celebrate and say now we can go full biohacking optimization! Ask what their main longevity or performance goal is. Energetic! Respond in: ${lang}` }], null, 150);

      } else if (!user.medicalHistory.medicalAsked && user.history.length >= 8) {
        user.medicalHistory.medicalAsked = true;
        reply = await callClaude([{ role: 'user', content: `Max. Ask about medical history warmly. Explain it helps personalize biohacking protocols. Ask: 1. Chronic conditions 2. Medications 3. Allergies. If none → "perfectly healthy". Note: guide not doctor. Respond in: ${lang}` }], null, 200);

      } else if (user.pendingMeal?.data) {
        const cr = await callClaude([{ role: 'user', content: `Max. Fix meal data: ${JSON.stringify(user.pendingMeal.data)}. Correction: "${msg}". Reply + DATA:{...}. Respond in: ${lang}` }], null, 400);
        const dm = cr.match(/DATA:(\{.*?\})/s);
        if (dm) { try { user.pendingMeal.data = JSON.parse(dm[1]); } catch (e) {} }
        reply = cr.replace(/DATA:\{.*?\}/s, '').trim();

      } else {
        await addToHistory(user, 'user', msg);
        const { summaryText, recentHistory } = buildContext(user);

        const system = MAX_PERSONALITY + `\n\n${summaryText ? summaryText + '\n\n' : ''}📊 Current status:
Name: ${user.profile?.name || '?'} | Age: ${user.profile?.age || '?'} | Streak: ${user.streak} days
Height: ${user.profile?.height || '?'} | Weight: ${user.profile?.weight || '?'} | BMI: ${user.profile?.bmi || '?'}
Meals today: ${user.todayMeals?.length || 0} | Steps: ${user.fitnessData?.todaySteps || 0} | Workout: ${user.fitnessData?.todayWorkoutMinutes || 0} min
Conditions: ${user.medicalHistory?.conditions?.join(', ') || 'none'} | Supplements: ${user.medicalHistory?.medications?.join(', ') || 'unknown'}
User language: ${lang} — RESPOND IN THIS LANGUAGE ONLY`;

        let aiReply = await callClaude(recentHistory, system, 1000);

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

        aiReply += capabilityHint(msg, user);
        reply = aiReply;
        await addToHistory(user, 'assistant', reply);

        if (user.onboardingDay < 3 && user.history.length > 6) {
          user.onboardingDay = Math.min(3, Math.floor(user.history.length / 6) + 1);
        }
      }
    } else {
      reply = isHeb ? `סוג הודעה לא נתמך 😅 שלח טקסט או תמונה!` : `Message type not supported 😅 Send text or image!`;
    }

    if (reply) await sendWhatsApp(userId, reply);
    await saveUser(user);

  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'Max v3.0 🚀', mongodb: !!usersCollection, youtube: !!YOUTUBE_API_KEY }));

connectDB().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log('Max v3.0 running!');
    console.log('MongoDB:', !!MONGODB_URI);
    console.log('YouTube API:', !!YOUTUBE_API_KEY);
    console.log('WhatsApp:', !!WA_TOKEN, '- v3.0');
  });
});
