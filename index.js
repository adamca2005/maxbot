const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const users = {};

app.post('/webhook', async (req, res) => {
  const userMsg = req.body.Body || '';
  const userId = req.body.From;

  if (!users[userId]) users[userId] = [];
  users[userId].push({ role: 'user', content: userMsg });
  if (users[userId].length > 20) users[userId] = users[userId].slice(-20);

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'You are Max, a personal coach. Be energetic and motivating. Keep responses short. Use emojis.',
        messages: users[userId]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const reply = response.data.content[0].text;
    users[userId].push({ role: 'assistant', content: reply });

    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>' + reply + '</Message></Response>');

  } catch (err) {
    console.error(err.message);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Error, try again</Message></Response>');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Max is running!'));
