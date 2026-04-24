const express = require('express');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = 'Eres Sofia, una ejecutiva de ventas amable y profesional de Carteleras.com, empresa especialista en publicidad exterior (Out of Home) en Mexico. Vendes espacios publicitarios en espectaculares, vallas, parabuses y pantallas digitales en ciudades como CDMX, Monterrey, Guadalajara, Merida y mas. Hablas espanol mexicano natural, con tono calido y conversacional. Tus respuestas son cortas (maximo 2 frases). Tu objetivo es entender la necesidad del cliente: que marca o producto promueve, en que ciudad quiere anunciar, cual es su presupuesto y por cuanto tiempo, para despues ofrecerle una cotizacion sin compromiso. Si pregunta precios, menciona que varian segun ubicacion y temporada pero que tienes opciones desde muy accesibles hasta premium. Siempre cierra invitando a agendar una llamada con un asesor para mandar propuesta formal.';
app.post('/voice', (req, res) => {
          const host = req.headers.host;
          res.type('text/xml');
          res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/stream" /></Connect></Response>`);
});

app.get('/', (req, res) => res.send('Agente IA Sofia activo'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

wss.on('connection', (ws) => {
          console.log('Nueva llamada conectada');
          let conversationHistory = [];
          let streamSid = null;
          let dgSocket = null;
          let isProcessing = false;
          let greeted = false;

         function sendAudio(audioBuffer) {
                     if (ws.readyState === WebSocket.OPEN && streamSid) {
                                   const chunkSize = 320;
                                   for (let i = 0; i < audioBuffer.length; i += chunkSize) {
                                                   const chunk = audioBuffer.slice(i, i + chunkSize);
                                                   ws.send(JSON.stringify({
                                                                     event: 'media',
                                                                     streamSid: streamSid,
                                                                     media: { payload: chunk.toString('base64') }
                                                   }));
                                   }
                                   ws.send(JSON.stringify({
                                                   event: 'mark',
                                                   streamSid: streamSid,
                                                   mark: { name: 'audio_done' }
                                   }));
                                   console.log('Audio enviado:', audioBuffer.length, 'bytes en', Math.ceil(audioBuffer.length/chunkSize), 'chunks');
                     } else {
                                   console.error('WS no disponible, streamSid:', streamSid);
                     }
         }

         function connectDeepgramSTT() {
                     const dgSTT = new WebSocket(
                                   'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=es&punctuate=true&interim_results=false&endpointing=300',
                             { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
                                 );
                     dgSTT.on('open', () => console.log('Deepgram STT conectado'));
                     dgSTT.on('message', async (data) => {
                                   try {
                                                   const result = JSON.parse(data);
                                                   const transcript = result?.channel?.alternatives?.[0]?.transcript;
                                                   if (transcript && transcript.trim() && result.is_final) {
                                                                     console.log('Cliente dijo:', transcript);
                                                                     if (!isProcessing) {
                                                                                         isProcessing = true;
                                                                                         await generateAndSendResponse(transcript);
                                                                                         isProcessing = false;
                                                                     }
                                                   }
                                   } catch (e) { console.error('Error STT:', e.message); }
                     });
                     dgSTT.on('error', (e) => console.error('Error Deepgram:', e.message));
                     dgSTT.on('close', () => console.log('Deepgram STT cerrado'));
                     return dgSTT;
         }

         async function callGroq(messages) {
                     return new Promise((resolve, reject) => {
                                   const body = JSON.stringify({
                                                   model: 'llama-3.3-70b-versatile',
                                                   messages: messages,
                                                   max_tokens: 100,
                                                   temperature: 0.7
                                   });
                                   const options = {
                                                   hostname: 'api.groq.com',
                                                   path: '/openai/v1/chat/completions',
                                                   method: 'POST',
                                                   headers: {
                                                                     'Authorization': `Bearer ${GROQ_API_KEY}`,
                                                                     'Content-Type': 'application/json',
                                                                     'Content-Length': Buffer.byteLength(body)
                                                   }
                                   };
                                   const req = https.request(options, (res) => {
                                                   let data = '';
                                                   res.on('data', chunk => data += chunk);
                                                   res.on('end', () => {
                                                                     try {
                                                                                         const parsed = JSON.parse(data);
                                                                                         if (parsed.error) reject(new Error(parsed.error.message));
                                                                                         else resolve(parsed.choices[0].message.content);
                                                                     } catch (e) { reject(e); }
                                                   });
                                   });
                                   req.on('error', reject);
                                   req.write(body);
                                   req.end();
                     });
         }

         async function textToSpeech(text) {
                     return new Promise((resolve, reject) => {
                                   const body = JSON.stringify({ text: text });
                                   const options = {
                                                   hostname: 'api.deepgram.com',
                                                   path: '/v1/speak?model=aura-2-thalia-es&encoding=mulaw&sample_rate=8000&container=none',
                                                   method: 'POST',
                                                   headers: {
                                                                     'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                                                                     'Content-Type': 'application/json',
                                                                     'Content-Length': Buffer.byteLength(body)
                                                   }
                                   };
                                   const req = https.request(options, (res) => {
                                                   console.log('TTS status:', res.statusCode);
                                                   const chunks = [];
                                                   res.on('data', chunk => chunks.push(chunk));
                                                   res.on('end', () => {
                                                                     const buf = Buffer.concat(chunks);
                                                                     if (res.statusCode !== 200) {
                                                                                         console.error('TTS error body:', buf.toString().substring(0, 200));
                                                                                         reject(new Error('TTS failed: ' + res.statusCode));
                                                                     } else {
                                                                                         console.log('TTS audio recibido:', buf.length, 'bytes');
                                                                                         resolve(buf);
                                                                     }
                                                   });
                                   });
                                   req.on('error', (e) => { console.error('TTS req error:', e.message); reject(e); });
                                   req.write(body);
                                   req.end();
                     });
         }

         async function generateAndSendResponse(userText) {
                     try {
                                   conversationHistory.push({ role: 'user', content: userText });
                                   const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversationHistory];
                                   const responseText = await callGroq(messages);
                                   console.log('Sofia responde:', responseText);
                                   conversationHistory.push({ role: 'assistant', content: responseText });
                                   const audioBuffer = await textToSpeech(responseText);
                                   sendAudio(audioBuffer);
                     } catch (error) {
                                   console.error('Error respuesta:', error.message);
                     }
         }

         ws.on('message', async (message) => {
                     try {
                                   const data = JSON.parse(message);
                                   if (data.event === 'start') {
                                                   streamSid = data.start.streamSid;
                                                   console.log('Stream iniciado:', streamSid);
                                                   dgSocket = connectDeepgramSTT();
                                                   setTimeout(async () => {
                                                                     if (!greeted) {
                                                                                         greeted = true;
                                                                                         try {
                                                                                                               console.log('Generando saludo...');
                                                                                                               const greetAudio = await textToSpeech('Hola, buenos dias. Le habla Sofia de Inmobiliaria Santa Fe. Le marco de Carteleras punto com. Ofrecemos espacios de publicidad exterior en toda la republica. Podria decirme que marca o producto le interesa promover?');
                                                                                                               sendAudio(greetAudio);
                                                                                                 } catch (e) { console.error('Error saludo:', e.message); }
                                                                     }
                                                   }, 500);
                                   }
                                   if (data.event === 'media' && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
                                                   const audioData = Buffer.from(data.media.payload, 'base64');
                                                   dgSocket.send(audioData);
                                   }
                                   if (data.event === 'stop') {
                                                   console.log('Llamada terminada');
                                                   if (dgSocket) dgSocket.close();
                                   }
                     } catch (e) { console.error('Error msg:', e.message); }
         });

         ws.on('close', () => {
                     console.log('WebSocket cerrado');
                     if (dgSocket) dgSocket.close();
         });
          ws.on('error', (e) => console.error('WS error:', e.message));
});

server.listen(PORT, () => console.log(`Servidor ${PORT} - Sofia Groq v2 lista`));
