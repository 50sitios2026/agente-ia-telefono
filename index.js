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

const SYSTEM_PROMPT = 'Eres Sofia, una agente inmobiliaria amigable que habla espanol mexicano. Llamas para preguntar sobre una propiedad en Santa Fe. Haz preguntas sobre precio, metros cuadrados, recamaras y disponibilidad. Responde de forma natural y breve, maximo 2 oraciones por respuesta.';

app.post('/voice', (req, res) => {
        const host = req.headers.host;
        res.type('text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-MX" voice="Polly.Lupe">Hola, buenos dias. Le llamo de parte de una inmobiliaria. Tenemos interes en su propiedad en Santa Fe.</Say><Connect><Stream url="wss://${host}/stream" /></Connect></Response>`);
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

         function connectDeepgramSTT() {
                   const dgSTT = new WebSocket(
                               'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=es&punctuate=true&interim_results=false&endpointing=500',
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
                      } catch (e) {
                                    console.error('Error STT:', e.message);
                      }
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
                                             max_tokens: 150,
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
                                                                                            if (parsed.error) {
                                                                                                                reject(new Error(parsed.error.message));
                                                                                                  } else {
                                                                                                                resolve(parsed.choices[0].message.content);
                                                                                                  }
                                                                          } catch (e) {
                                                                                            reject(e);
                                                                          }
                                                          });
                                            });

                                            req.on('error', reject);
                               req.write(body);
                               req.end();
                   });
         }

         async function textToSpeech(text) {
                   return new Promise((resolve, reject) => {
                               const body = JSON.stringify({
                                             text: text,
                                             model: 'aura-2-thalia-es',
                                             encoding: 'mulaw',
                                             sample_rate: 8000,
                                             container: 'none'
                               });

                                            const options = {
                                                          hostname: 'api.deepgram.com',
                                                          path: '/v1/speak',
                                                          method: 'POST',
                                                          headers: {
                                                                          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                                                                          'Content-Type': 'application/json',
                                                                          'Content-Length': Buffer.byteLength(body)
                                                          }
                                            };

                                            const req = https.request(options, (res) => {
                                                          const chunks = [];
                                                          res.on('data', chunk => chunks.push(chunk));
                                                          res.on('end', () => resolve(Buffer.concat(chunks)));
                                            });

                                            req.on('error', reject);
                               req.write(body);
                               req.end();
                   });
         }

         async function generateAndSendResponse(userText) {
                   try {
                               conversationHistory.push({ role: 'user', content: userText });

                     const messages = [
                           { role: 'system', content: SYSTEM_PROMPT },
                                   ...conversationHistory
                                 ];

                     const responseText = await callGroq(messages);
                               console.log('Sofia responde:', responseText);

                     conversationHistory.push({ role: 'assistant', content: responseText });

                     const audioBuffer = await textToSpeech(responseText);
                               const base64Audio = audioBuffer.toString('base64');

                     if (ws.readyState === WebSocket.OPEN && streamSid) {
                                   ws.send(JSON.stringify({
                                                   event: 'media',
                                                   streamSid: streamSid,
                                                   media: { payload: base64Audio }
                                   }));
                     }
                   } catch (error) {
                               console.error('Error generando respuesta:', error.message);
                   }
         }

         ws.on('message', (message) => {
                   try {
                               const data = JSON.parse(message);

                     if (data.event === 'start') {
                                   streamSid = data.start.streamSid;
                                   console.log('Stream iniciado:', streamSid);
                                   dgSocket = connectDeepgramSTT();

                                 setTimeout(async () => {
                                                 try {
                                                                   const greetAudio = await textToSpeech('Hola, buenos dias. Le habla Sofia de una inmobiliaria. Nos interesa su propiedad en Santa Fe. Podria decirme el precio que solicita?');
                                                                   const base64Audio = greetAudio.toString('base64');
                                                                   if (ws.readyState === WebSocket.OPEN && streamSid) {
                                                                                       ws.send(JSON.stringify({
                                                                                                             event: 'media',
                                                                                                             streamSid: streamSid,
                                                                                                             media: { payload: base64Audio }
                                                                                             }));
                                                                   }
                                                 } catch (e) {
                                                                   console.error('Error saludo:', e.message);
                                                 }
                                 }, 1000);
                     }

                     if (data.event === 'media' && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
                                   const audioData = Buffer.from(data.media.payload, 'base64');
                                   dgSocket.send(audioData);
                     }

                     if (data.event === 'stop') {
                                   console.log('Llamada terminada');
                                   if (dgSocket) dgSocket.close();
               }
                   } catch (e) {
                               console.error('Error mensaje:', e.message);
                   }
         });

         ws.on('close', () => {
                   console.log('WebSocket cerrado');
                   if (dgSocket) dgSocket.close();
         });
});

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT} con Groq Llama 3.3`));
