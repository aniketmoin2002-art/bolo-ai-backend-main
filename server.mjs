import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const KEY = process.env.GEMINI_API_KEY;
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const imageEditRequests = new Map();
const loginAttempts = new Map();
const indexFile = fileURLToPath(new URL('./index.html', import.meta.url));
const adminFile = fileURLToPath(new URL('./admin.html', import.meta.url));
const stats = {
  chat: { requests: 0, errors: 0, totalMs: 0, lastAt: null },
  imageEdit: { requests: 0, errors: 0, totalMs: 0, lastAt: null }
};

app.use(express.json({ limit: '12mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', credentials: true }));
app.get('/', (_req, res) => res.sendFile(indexFile));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/admin', (_req, res) => res.sendFile(adminFile));

function track(type, handler) {
  return (req, res) => {
    const started = Date.now();
    stats[type].requests += 1;
    stats[type].lastAt = new Date(started).toISOString();
    res.once('finish', () => {
      stats[type].totalMs += Date.now() - started;
      if (res.statusCode >= 400) stats[type].errors += 1;
    });
    return handler(req, res);
  };
}

function sessionSignature(expires) {
  return createHmac('sha256', ADMIN_PASSWORD).update('bolo-admin:' + expires).digest('hex');
}

function hasAdminSession(req) {
  if (!ADMIN_PASSWORD) return false;
  const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('bolo_admin_session='));
  if (!cookie) return false;
  const token = decodeURIComponent(cookie.slice('bolo_admin_session='.length));
  const [expiresText, signature] = token.split('.');
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires < Date.now() || !signature) return false;
  const expected = sessionSignature(expires);
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireAdmin(req, res, next) {
  if (hasAdminSession(req)) return next();
  return res.status(401).json({ error: ADMIN_PASSWORD ? 'Sign in to view admin data.' : 'Admin password is not configured.' });
}

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Set ADMIN_PASSWORD in Render environment variables.' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter(time => now - time < 15 * 60 * 1000);
  if (attempts.length >= 6) return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
  attempts.push(now);
  loginAttempts.set(ip, attempts);
  const provided = typeof req.body?.password === 'string' ? req.body.password : '';
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (providedHash.length !== expectedHash.length || !timingSafeEqual(providedHash, expectedHash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  loginAttempts.delete(ip);
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  res.setHeader('Set-Cookie', 'bolo_admin_session=' + expires + '.' + sessionSignature(expires) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800');
  return res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'bolo_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  return res.json({ ok: true });
});

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const summary = value => ({
    requests: value.requests,
    errors: value.errors,
    averageMs: value.requests ? Math.round(value.totalMs / value.requests) : 0,
    lastAt: value.lastAt
  });
  return res.json({
    ok: true,
    status: 'online',
    textModel: MODEL,
    imageModel: IMAGE_MODEL,
    uptimeSeconds: Math.floor(process.uptime()),
    apiKeyConfigured: Boolean(KEY),
    metricsNote: 'Counts and averages cover this running server process only and reset when it restarts or redeploys.',
    chat: summary(stats.chat),
    imageEdit: summary(stats.imageEdit)
  });
});

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
    } finally { clearTimeout(timeout); }
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Gemini request failed' });
    const reply = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
    if (!reply) return res.status(502).json({ error: 'AI returned no text.' });
    res.json({ reply, response: reply, answer: reply });
  } catch (error) {
    res.status(502).json({ error: error.name === 'AbortError' ? 'AI request timed out.' : 'Unable to contact AI provider.' });
  }
}

app.post('/api/edit-image', track('imageEdit', editImage));
app.post('/chat', track('chat', answer));
app.post('/api/chat', track('chat', answer));
app.listen(PORT, '0.0.0.0', () => console.log('Bolo AI listening on port ' + PORT));


const pwaAssets = {
  "/manifest.webmanifest": "manifest.webmanifest",
  "/admin.webmanifest": "admin.webmanifest",
  "/bolo-icon.svg": "bolo-icon.svg",
  "/bolo-admin-icon.svg": "bolo-admin-icon.svg",
  "/service-worker.js": "service-worker.js"
};
for (const [route, asset] of Object.entries(pwaAssets)) {
  app.get(route, (_req, res) => res.sendFile(fileURLToPath(new URL("./" + asset, import.meta.url))));
}
