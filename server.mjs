import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';


const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const KEY = process.env.GEMINI_API_KEY;
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const imageEditRequests = new Map();
const indexFile = fileURLToPath(new URL('./index.html', import.meta.url));


app.use(express.json({ limit: '12mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.get('/', (_req, res) => res.sendFile(indexFile));
app.get('/health', (_req, res) => res.json({ ok: true }));


async function editImage(req, res) {
  if (!KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  const { image, mimeType, prompt, aspectRatio } = req.body || {};
  if (typeof image !== 'string' || !image) return res.status(400).json({ error: 'Upload an image to edit.' });
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return res.status(415).json({ error: 'Use a PNG, JPG, or WEBP image.' });
  if (image.length > 10000000) return res.status(413).json({ error: 'Image is too large. Choose an image under 7 MB.' });
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Describe the change you want to make.' });
  if (prompt.length > 1000) return res.status(400).json({ error: 'Keep the edit instruction under 1,000 characters.' });
  const now = Date.now();
  const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (imageEditRequests.get(clientKey) || []).filter(time => now - time < 10 * 60 * 1000);
  if (recent.length >= 8) return res.status(429).json({ error: 'Image edit limit reached. Try again in a few minutes.' });
  recent.push(now); imageEditRequests.set(clientKey, recent);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(IMAGE_MODEL) + ':generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Edit the uploaded image according to this instruction. Preserve the main subject and details the user did not ask to change. Return the edited image. Instruction: ' + prompt.trim() }, { inlineData: { mimeType, data: image } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ['1:1','3:2','2:3','4:3','3:4','16:9','9:16'].includes(aspectRatio) ? aspectRatio : '1:1', imageSize: '1K' } } }),
        signal: controller.signal
      });
    } finally { clearTimeout(timeout); }
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Gemini image editing failed.' });
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData?.data || part.inline_data?.data);
    if (!imagePart) return res.status(502).json({ error: parts.map(part => part.text || '').filter(Boolean).join('\n') || 'Gemini did not return an edited image. Try another instruction.' });
    const inline = imagePart.inlineData || imagePart.inline_data;
    res.json({ image: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png', text: parts.map(part => part.text || '').filter(Boolean).join('\n') });
  } catch (error) {
    res.status(502).json({ error: error.name === 'AbortError' ? 'Image editing timed out. Try a smaller image.' : 'Unable to contact the image editing service.' });
  }
}

async function answer(req, res) {
  if (!KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  const { message, prompt, messages } = req.body || {};
  const input = message || prompt;
  const contents = Array.isArray(messages) && messages.length
    ? messages.filter(m => m && typeof m.content === 'string').slice(-8).map(m => ({ role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user', parts: [{ text: m.content }] }))
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
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'minimal' } } }),
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


app.post('/api/edit-image', editImage);
app.post('/chat', answer);
app.post('/api/chat', answer);
app.listen(PORT, '0.0.0.0', () => console.log('Bolo AI listening on port ' + PORT));

