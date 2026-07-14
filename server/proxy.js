const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// --- Chat proxy config ---
const TARGET = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const API_KEY = process.env.ARK_API_KEY || '';

// --- TTS config ---
const XFYUN_APPID = process.env.XFYUN_APPID || '';
const XFYUN_APIKEY = process.env.XFYUN_APIKEY || '';
const XFYUN_APISecret = process.env.XFYUN_APISecret || '';
const TTS_VOICE = process.env.TTS_VOICE || 'x4_yezi';
const TTS_RES_ID = process.env.TTS_RES_ID || ''; // voice clone assetId

// --- iFlytek TTS auth URL ---
function getTTSAuthUrl() {
  const isClone = !!TTS_RES_ID;
  const host = isClone ? 'cn-huabei-1.xf-yun.com' : 'tts-api.xfyun.cn';
  const path = isClone ? '/v1/private/voice_clone' : '/v2/tts';
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', XFYUN_APISecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${XFYUN_APIKEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
}

// --- Minimal WebSocket frame helpers (RFC 6455) ---
function wsSend(socket, data) {
  const payload = Buffer.from(data, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
    mask.copy(header, 10);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  socket.write(Buffer.concat([header, masked]));
}

function parseWsFrames(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (buf.length < 4) break;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) break;
      payloadLen = buf.readUInt32BE(6);
      offset = 10;
    }
    if (masked) offset += 4; // server shouldn't mask but handle it
    if (buf.length < offset + payloadLen) break;
    let payload = buf.slice(offset, offset + payloadLen);
    if (masked) {
      const msk = buf.slice(offset - 4, offset);
      for (let i = 0; i < payload.length; i++) payload[i] ^= msk[i % 4];
    }
    frames.push({ opcode, payload });
    buf = buf.slice(offset + payloadLen);
  }
  return { frames, remaining: buf };
}

// --- TTS via iFlytek WebSocket ---
function ttsRequest(text, style) {
  return new Promise((resolve, reject) => {
    const authUrl = getTTSAuthUrl();
    const parsed = new URL(authUrl);
    const wsKey = crypto.randomBytes(16).toString('base64');
    let wsSocket = null;
    let resolved = false;

    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13',
      }
    });

    req.on('upgrade', (res, socket, head) => {
      wsSocket = socket;
      const audioChunks = [];
      let buf = Buffer.alloc(0);
      if (head && head.length) buf = Buffer.concat([buf, head]);

      // Send TTS request frame
      const isClone = !!TTS_RES_ID;
      const frame = isClone ? {
        header: { app_id: XFYUN_APPID, status: 2, res_id: TTS_RES_ID },
        parameter: {
          tts: {
            vcn: 'x6_clone', volume: 50, speed: 55, pitch: 54,
            style: style || 'cute', impactFactor: 3,
            audio: { encoding: 'lame', sample_rate: 24000 }
          }
        },
        payload: {
          text: { encoding: 'utf8', compress: 'raw', format: 'plain', status: 2, seq: 0, text: Buffer.from(text).toString('base64') }
        }
      } : {
        common: { app_id: XFYUN_APPID },
        business: {
          aue: 'lame', sfl: 1,
          auf: 'audio/L16;rate=16000',
          vcn: TTS_VOICE,
          speed: 50, volume: 50, pitch: 80,
          tte: 'UTF8'
        },
        data: { status: 2, text: Buffer.from(text).toString('base64') }
      };
      wsSend(socket, JSON.stringify(frame));

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { frames, remaining } = parseWsFrames(buf);
        buf = remaining;
        for (const f of frames) {
          if (f.opcode === 8) { // close
            socket.end();
            if (!resolved) { resolved = true; resolve(Buffer.concat(audioChunks)); }
            return;
          }
          if (f.opcode === 1) { // text
            try {
              const msg = JSON.parse(f.payload.toString());
              // Clone API uses header.code, standard TTS uses code
              const code = msg.header?.code ?? msg.code ?? 0;
              const message = msg.header?.message ?? msg.message ?? '';
              if (code !== 0) {
                socket.end();
                if (!resolved) { resolved = true; reject(new Error(message || 'TTS error ' + code)); }
                return;
              }
              if (msg.payload?.audio?.audio) {
                audioChunks.push(Buffer.from(msg.payload.audio.audio, 'base64'));
              } else if (msg.data && msg.data.audio) {
                audioChunks.push(Buffer.from(msg.data.audio, 'base64'));
              }
              const status = msg.header?.status ?? msg.data?.status;
              if (status === 2) {
                socket.end();
                if (!resolved) { resolved = true; resolve(Buffer.concat(audioChunks)); }
                return;
              }
            } catch (e) { /* skip bad json */ }
          }
        }
      });

      socket.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
      socket.on('close', () => { if (!resolved) { resolved = true; resolve(Buffer.concat(audioChunks)); } });
    });

    req.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    req.setTimeout(30000, () => { req.destroy(); if (!resolved) { resolved = true; reject(new Error('TTS timeout')); } });
    req.end();
  });
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept'
    });
    return res.end();
  }

  // Route: TTS
  if (req.url === '/api/tts' && req.method === 'POST') {
    return handleTTS(req, res);
  }

  // Route: Chat (original)
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const url = new URL(TARGET);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Accept': req.headers['accept'] || 'text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      }
    };

    const proxyReq = https.request(url, options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

function handleTTS(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { text: rawText, style } = JSON.parse(body);
      // Replace tilde with comma for TTS pause, clean up whitespace
      const text = (rawText || '').replace(/[~～]/g, '，').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 2000) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'text required, max 2000 chars' }));
      }
      if (!XFYUN_APPID || !XFYUN_APIKEY || !XFYUN_APISecret) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'TTS not configured' }));
      }

      const audioBuffer = await ttsRequest(text, style);
      res.writeHead(200, {
        'Content-Type': 'audio/mp3',
        'Content-Length': audioBuffer.length,
        'Cache-Control': 'no-cache',
      });
      res.end(audioBuffer);
    } catch (e) {
      console.error('[tts] error:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

server.listen(18901, '127.0.0.1', () => {
  console.log('littlerp proxy listening on 127.0.0.1:18901 (chat + tts)');
});
