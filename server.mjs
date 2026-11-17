import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;
const indexFile = fileURLToPath(new URL('./index.html', import.meta.url));

app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.get('/', (_req, res) => res.sendFile(indexFile));
app.get('/health', (_req, res) => res.json({ ok: true }));

async function answer(req, res) {
  if (!KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  const { message, prompt, messages } = req.body || {};
  const input = message || prompt;
  const contents = Array.isArray(messages) && messages.length
    ? messages.filter(m => m && typeof m.content === 'string').slice(-20).map(m => ({ role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user', parts: [{ text: m.content }] }))
    : typeof input === 'string' && input.trim() ? [{ role: 'user', parts: [{ text: input.trim() }] }] : null;
  if (!contents?.length) return res.status(400).json({ error: 'Send JSON with message or messages.' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096 } }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Gemini request failed' });
    const reply = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
    if (!reply) return res.status(502).json({ error: 'AI returned no text.' });
    res.json({ reply, response: reply, answer: reply });
  } catch (error) {
    res.status(502).json({ error: error.name === 'AbortError' ? 'AI request timed out.' : 'Unable to contact AI provider.' });
  }
}

app.post('/chat', answer);
app.post('/api/chat', answer);
app.listen(PORT, '0.0.0.0', () => console.log('Bolo AI listening on port ' + PORT));
