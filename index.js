// index.js
import fetch from 'node-fetch';
import https from 'https';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
//import { randomUUID } from 'crypto';
import crypto from 'crypto';

// —————————————————————————————————
//  Настройки: замените ключи на ваши
// —————————————————————————————————
const SALUTE_AUTH_KEY  = 'NTZhYWNhZGMtOWI5YS00NmMxLTk2MTUtZmY5NjFkNWNmOTYwOjA3Y2ZmYWI4LTBlMWMtNDlkNi05ZTdhLTA4ZTZlMjYwNGZiNQ==';
const SALUTE_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const SALUTE_STT_URL   = 'https://smartspeech.sber.ru/rest/v1/speech:recognize';
const SALUTE_TTS_URL   = 'https://smartspeech.sber.ru/rest/v1/text:synthesize';
const OWM_API_KEY      = 'f7e25b9ecf6718c0f7ee7d805a8173ea';
const CITY_CSV_PATH    = 'UTF-8_Q_CITY.csv';

const agent = new https.Agent({ rejectUnauthorized: false });
let _token = null, _expires = 0;

// 1) OAuth token с кэшем
async function getToken() {
  const now = Date.now();
  if (_token && now < _expires) return _token;

  const res = await fetch(SALUTE_OAUTH_URL, {
    method: 'POST', agent,
    headers: {
      'Authorization': `Basic ${SALUTE_AUTH_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
      'RqUID':         uuid()
    },
    body: new URLSearchParams({ scope: 'SALUTE_SPEECH_PERS' })
  });
  if (!res.ok) throw new Error(`OAuth ${res.status}`);
  const { access_token, expires_in } = await res.json();
  _token   = access_token;
  _expires = now + expires_in*1000 - 5000;
  return _token;
}

function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;  // version 4
  b[8] = (b[8] & 0x3f) | 0x80;  // variant
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0'));
  return [
    hex.slice(0,4).join(''),
    hex.slice(4,6).join(''),
    hex.slice(6,8).join(''),
    hex.slice(8,10).join(''),
    hex.slice(10,16).join('')
  ].join('-');
}

// 2) Чтение CSV-карты (raw→nominative)
async function loadCityMap(path = CITY_CSV_PATH) {
  const txt = await fs.readFile(path, 'utf-8');
  const rawMap = {}, nomMap = {};
  for (let line of txt.split(/\r?\n/)) {
    const [id, raw, nomJson] = line.split(';');
    if (!raw || !nomJson) continue;
    const rawKey = raw.trim().toLowerCase();
    let nom = nomJson.trim().replace(/[\"{}]/g, '').split(',')[0];
    nomMap[nom.toLowerCase()] = nom;
    rawMap[rawKey] = nom;
  }
  return { rawMap, nomMap };
}

// 3) Запись микрофона через sox → PCM
async function recordAudio(ms = 5000) {
  console.log('=== Recording audio ===');
  return new Promise((ok, nok) => {
    const proc = spawn('sox', [
      '-t','alsa','default','-r','24000','-c','1','-b','16','-e','signed-integer',
      '-t','raw','-','trim','0', String(ms/1000)
    ]);
    const bufs = [];
    proc.stdout.on('data', d => bufs.push(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('error', nok);
    proc.on('close', code => code===0 ? ok(Buffer.concat(bufs)) : nok(new Error(`sox ${code}`)));
  });
}

// 4) STT
async function recognize(pcm) {
  console.log('=== Recognizing ===');
  const token = await getToken();
  const res = await fetch(SALUTE_STT_URL, {
    method: 'POST', agent,
    headers: {
      'Authorization':    `Bearer ${token}`,
      'Content-Type':     'audio/x-pcm;bit=16;rate=24000',
      'X-Request-ID':     uuid(),
      'X-Audio-Channels': '1'
    },
    body: pcm
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  const { result } = await res.json();
  const txt = Array.isArray(result) ? result.join(' ') : result;
  console.log('Recognized:', txt);
  return txt;
}

// 5) Геокодер с fallback’ами
async function geocode(raw, maps) {
  const { rawMap, nomMap } = maps;
  const tried = [];
  // helper
  async function tryOne(name, label) {
    tried.push(label);
    const url = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(name)}&limit=1&appid=${OWM_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Geo ${r.status}`);
    const a = await r.json();
    return a[0] ? { lat: a[0].lat, lon: a[0].lon } : null;
  }

  const key = raw.toLowerCase().replace(/[?.!]+$/,'');
  // 1) номинатив
  if (nomMap[key]) {
    const c = await tryOne(nomMap[key], `nom=${nomMap[key]}`);
    if (c) return c;
  }
  // 2) raw→nom
  if (rawMap[key]) {
    const c = await tryOne(rawMap[key], `raw=${rawMap[key]}`);
    if (c) return c;
  }
  // 3) префиксы (однословный)
  for (let len=2; len<=key.length; len++) {
    const pre = key.slice(0,len);
    const cands = Object.entries(rawMap).filter(([r]) => r.startsWith(pre));
    if (cands.length===1) {
      const name = cands[0][1];
      const c = await tryOne(name, `pref=${pre}`);
      if (c) return c;
    }
  }
  // 4) морфология «ем»→«ий», «е»→«»
  let morph = key.replace(/ё/g,'е');
  if (morph.endsWith('ем')) morph = morph.slice(0,-2)+'ий';
  else if (morph.endsWith('е')) morph = morph.slice(0,-1);
  if (morph!==key) {
    const c = await tryOne(morph, `morph=${morph}`);
    if (c) return c;
  }
  // 5) оригинал
  const orig = await tryOne(raw, `orig=${raw}`);
  if (orig) return orig;

  throw new Error(`City not found (tried: ${tried.join(',')})`);
}

// 6) Погода по координатам
async function fetchWeather({lat,lon}) {
  console.log('=== Fetching weather ===');
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric&lang=ru`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OWM ${r.status}`);
  const j = await r.json();
  return { description: j.weather[0].description, temp: Math.round(j.main.temp) };
}

// 7) TTS
async function synthesize(text, file='answer.wav') {
  console.log('=== Synthesizing:', text);
  const token = await getToken();
  const url = `${SALUTE_TTS_URL}?voice=May_24000&format=wav16`;
  const r = await fetch(url, {
    method: 'POST', agent,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/text',
      'X-Request-ID':  uuid()
    },
    body: text
  });
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(file, buf);
  return file;
}

// 8) Воспроизведение через sox/play
async function playWav(file) {
  console.log('=== Playing:', file);
  return new Promise((ok, nok) => {
    const p = spawn('play', [ file ]);
    p.stderr.on('data', d => process.stderr.write(d));
    p.on('error', nok);
    p.on('close', code => code===0 ? ok() : nok(new Error(`play ${code}`)));
  });
}

// === MAIN ===
(async()=>{
  try {
    const cityMap = await loadCityMap();
    const pcm     = await recordAudio();
    const text    = await recognize(pcm);
    const m       = text.match(/погода\s+в\s+(.+)/i);
    if (!m) throw new Error('“погода в” не найдена');
    const cityRaw = m[1].replace(/[?.!]+$/,'').trim();

    // нормализация для вывода
    let key = cityRaw.toLowerCase();
    if (key.endsWith('е')) key = key.slice(0,-1);
    const cityNorm = (cityMap.rawMap[key] !== undefined ? cityMap.rawMap[key] : cityRaw);
    console.log('City normalized:', cityNorm);

    // геокод и погода
    const coords = await geocode(cityRaw, cityMap);
    const w      = await fetchWeather(coords);

    const reply = `Погода в ${cityNorm}: ${w.description}, ${w.temp}°C.`;
    const wav   = await synthesize(reply);
    await playWav(wav);

  } catch(err) {
    console.error('!!! Error:', err.message);
  }
})();
