# Bolo AI Gemini backend

1. Upload `server.mjs`, `package.json`, and `.gitignore` to a GitHub repository (never upload your API key).
2. On Render create a Node Web Service connected to that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `GEMINI_API_KEY` with your own Google AI Studio API key.
6. Deploy. Open your Render URL to see the server status.
7. Your app can POST JSON `{ "message": "नमस्ते" }` to `https://YOUR-SERVICE.onrender.com/chat` or `/api/chat`.

Example response: `{ "reply": "...", "response": "...", "answer": "..." }`.

Optional: `GEMINI_MODEL` to change model; `ALLOWED_ORIGIN` to restrict browser origins (recommended before public launch).

Important: This backend does not implement live web search. Public deployment needs authentication, rate limits and more restrictive CORS to prevent abuse. Your existing HTML frontend may use a different request format; adapt its endpoint/response handling if necessary.
