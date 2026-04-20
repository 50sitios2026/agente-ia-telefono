const express = require('express');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = 'Eres Sofia, una agente inmobiliaria amigable que habla espanol mexicano. Llamas porque te interesa la propiedad en Santa Fe. Eres calida, natural y conversacional. Usa frases cortas. Pregunta sobre precio, metros, recamaras y disponibilidad. Maximo 2-3 oraciones por respuesta.';

app.post('/voice', (req, res) => {
  const host = req.headers.host;
  res.type('text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-MX" voice="Polly.Lupe">Hola, un momento por favor.</Say><Connect><Stream url="wss://' + host + '/media-stream" /></Connect></Response>');
});

app.get('/', (req, res) => res.send('Agente IA Sofia activo'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('Llamada conectada');
  let streamSid = null;
  let conversationHistory = [];
  let deepgramWs = null;
  let isSpeaking = false;

  function connectDeepgram() {
    deepgramWs = new WebSocket(
      'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=es&punctuate=true&interim_results=false&endpointing=500',
      { headers: { Authorization: 'Token ' + DEEPGRAM_API_KEY } }
    );
    deepgramWs.on('open', () => console.log('Deepgram conectado'));
    deepgramWs.on('message', async (data) => {
      const result = JSON.parse(data.toString());
      const transcript = result?.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.trim() && result.is_final) {
        console.log('Cliente:', transcript);
        await processMessage(transcript);
      }
    });
    deepgramWs.on('error', (e) => console.error('Deepgram error:', e));
  }

  async function processMessage(text) {
    if (isSpeaking) return;
    isSpeaking = true;
    conversationHistory.push({ role: 'user', content: text });
    try {
      const response = await anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: conversationHistory,
      });
      const reply = response.content[0].text;
      conversationHistory.push({ role: 'assistant', content: reply });
      console.log('Sofia:', reply);
      await speakText(reply);
    } catch (e) {
      console.error('Error Claude:', e);
    }
    isSpeaking = false;
  }

  async function speakText(text) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ text });
      const options = {
        hostname: 'api.deepgram.com',
        path: '/v1/speak?model=aura-2-diana-es&encoding=mulaw&sample_rate=8000',
        method: 'POST',
        headers: {
          Authorization: 'Token ' + DEEPGRAM_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const audio = Buffer.concat(chunks).toString('base64');
          const size = 320;
          for (let i = 0; i < audio.length; i += size) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audio.substring(i, i + size) } }));
            }
          }
          resolve();
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async function greet() {
    const g = 'Hola buenos dias, con quien tengo el gusto? Le llamo porque me intereso mucho su propiedad en Santa Fe.';
    await speakText(g);
    conversationHistory.push({ role: 'assistant', content: g });
    isSpeaking = false;
  }

  twilioWs.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      connectDeepgram();
      setTimeout(greet, 1000);
    } else if (data.event === 'media' && deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.send(Buffer.from(data.media.payload, 'base64'));
    } else if (data.event === 'stop') {
      deepgramWs?.close();
    }
  });

  twilioWs.on('close', () => deepgramWs?.close());
});

server.listen(PORT, () => console.log('Servidor en puerto', PORT));
