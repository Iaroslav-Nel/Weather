// index.js
import fetch from 'node-fetch';
import https from 'https';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

// —————————————————————————————————
// Настройки: замените ключи на ваши
// —————————————————————————————————
const SALUTE_AUTH_KEY  = 'NTZhYWNhZGMtOWI5YS00NmMxLTk2MTUtZmY5NjFkNWNmOTYwOjA3Y2ZmYWI4LTBlMWMtNDlkNi05ZTdhLTA4ZTZlMjYwNGZiNQ==';
const SALUTE_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const SALUTE_STT_URL   = 'https://smartspeech.sber.ru/rest/v1/speech:recognize';
const SALUTE_TTS_URL   = 'https://smartspeech.sber.ru/rest/v1/text:synthesize';
const OWM_API_KEY      = 'f7e25b9ecf6718c0f7ee7d805a8173ea';
const CITY_CSV_PATH    = 'UTF-8_Q_CITY.csv';

const agent = new https.Agent({ rejectUnauthorized: false });
let _token = null;
let _expires = 0;

// OAuth token
async function getToken() {
  const now = Date.now();
  if (_token && now < _expires) return _token;
  const res = await fetch(SALUTE_OAUTH_URL, {
    method: 'POST', agent,
    headers: {
      'Authorization': `Basic ${SALUTE_AUTH_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
      'RqUID':         randomUUID()
    },
    body: new URLSearchParams({ scope: 'SALUTE_SPEECH_PERS' })
  });
  if (!res.ok) throw new Error(`OAuth error ${res.status}`);
  const { access_token, expires_in } = await res.json();
  _token = access_token;
  _expires = now + expires_in * 1000 - 5000;
  return _token;
}

// Load city mapping from CSV
async function loadCityMap(path = CITY_CSV_PATH) {
  const text = await fs.readFile(path, 'utf-8');
  const rawMap = {}, nomMap = {};
  text.split(/\\r?\\n/).forEach(line => {
    const parts = line.split(';');
    if (parts.length < 3) return;
    const raw = parts[1].trim().toLowerCase();
    let nom = parts[2].trim();
    if (nom.includes(',')) nom = nom.split(',')[0];
    nom = nom.replace(/[\"{}]/g, '').trim();
    rawMap[raw] = nom;
    nomMap[nom.toLowerCase()] = nom;
  });
  return { rawMap, nomMap };
}

// Record via sox ALSA → PCM
async function recordAudio(durationMs = 5000) {
  console.log('=== Recording audio ===');
  return new Promise((resolve, reject) => {
    const args = ['-t','alsa','default','-r','24000','-c','1','-b','16','-e','signed-integer','-t','raw','-','trim','0',String(durationMs/1000)];
    const proc = spawn('sox', args);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', d => console.error(d.toString()));
    proc.on('error', reject);
    proc.on('close', code => code===0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`sox exited ${code}`)));
  });
}

// STT
async function recognize(pcm) {
  console.log('=== Recognizing ===');
  const token = await getToken();
  const res = await fetch(SALUTE_STT_URL, {
    method: 'POST', agent,
    headers: {
      'Authorization':    `Bearer ${token}`,
      'Content-Type':     'audio/x-pcm;bit=16;rate=24000',
      'X-Request-ID':     randomUUID(),
      'X-Audio-Channels': '1'
    }, body: pcm
  });
  if (!res.ok) throw new Error(`STT error ${res.status}`);
  const { result } = await res.json();
  const text = Array.isArray(result) ? result.join(' ') : result;
  console.log('=== Recognized:', text);
  return text;
}

// Geocode via OWM
// Геокодирование с деклинацией по словам + префиксный поиск
// Геокодирование с поддержкой двухсловных префиксных комбинаций
async function geocode(cityRaw, maps) {
  const { rawMap, nomMap } = maps;
  const tried = [];

  // Вспомогательная пробующая функция
  async function tryCity(name, label) {
    tried.push(label);
    const url = `http://api.openweathermap.org/geo/1.0/direct`
      + `?q=${encodeURIComponent(name)}&limit=1&appid=${OWM_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
    const arr = await res.json();
    return arr.length ? { lat: arr[0].lat, lon: arr[0].lon } : null;
  }

  const key = cityRaw.toLowerCase().replace(/[?.!]*$/, '');
  const words = key.split(/\s+/);

  // 1) Номинатив
  if (nomMap[key]) {
    const c = await tryCity(nomMap[key], `nom=${nomMap[key]}`);
    if (c) return c;
  }

  // 2) Точная raw-форма
  if (rawMap[key]) {
    const c = await tryCity(rawMap[key], `raw=${rawMap[key]}`);
    if (c) return c;
  }

  // 3) Двухсловные префиксные комбинации (по первым N символам каждого слова)
  if (words.length === 2) {
    const [w1, w2] = words;
    for (let l1 = 2; l1 <= w1.length; l1++) {
      for (let l2 = 2; l2 <= w2.length; l2++) {
        const p1 = w1.slice(0, l1);
        const p2 = w2.slice(0, l2);
        const cands = Object.entries(rawMap).filter(
          ([raw]) => {
            const parts = raw.split(/\s+/);
            return parts.length === 2
              && parts[0].startsWith(p1)
              && parts[1].startsWith(p2);
          }
        );
        if (cands.length === 1) {
          const name = cands[0][1];
          const c = await tryCity(name, `2prefix=${p1}+${p2}`);
          if (c) return c;
        }
      }
    }
  }

  // 4) Однословный префиксный поиск
  for (let len = 2; len <= key.length; len++) {
    const prefix = key.slice(0, len);
    const cands = Object.entries(rawMap).filter(([raw]) => raw.startsWith(prefix));
    if (cands.length === 1) {
      const name = cands[0][1];
      const c = await tryCity(name, `prefix=${prefix}`);
      if (c) return c;
    }
  }

  // 5) Морфологическое обрезание окончаний
  const morph = words.map(w => {
    if (w.endsWith('ем')) return w.slice(0, -2) + 'ий';
    if (w.endsWith('е'))  return w.slice(0, -1);
    return w;
  }).join(' ');
  if (morph !== key) {
    const c = await tryCity(morph, `morph=${morph}`);
    if (c) return c;
  }

  // 6) Фоллбэк — оригинал
  const orig = await tryCity(cityRaw, `orig=${cityRaw}`);
  if (orig) return orig;

  throw new Error(`City not found (tried: ${tried.join(',')})`);
}



// Weather fetch
async function fetchWeather({ lat, lon }) {
  console.log('=== Fetching weather ===');
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric&lang=ru`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OWM error ${res.status}`);
  const d = await res.json();
  return { description: d.weather[0].description, temp: Math.round(d.main.temp) };
}

// TTS
async function synthesize(text, file='answer.wav') {
  console.log('=== Synthesizing:', text);
  const token = await getToken();
  const url = `${SALUTE_TTS_URL}?voice=May_24000&format=wav16`;
  const res = await fetch(url, { method:'POST', agent,
    headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/text','X-Request-ID':randomUUID()}, body:text
  });
  if (!res.ok) throw new Error(`TTS error ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
  console.log('=== WAV saved:', file);
  return file;
}

// Play
async function playWav(file) {
  console.log('=== Playing:', file);
  return new Promise((res,rej) => {
    const p = spawn('play',[file]);
    p.stderr.on('data', d => process.stderr.write(d));
    p.on('error', rej);
    p.on('close', code => code===0?res():rej(new Error(`play exited ${code}`)));
  });
}

// Main
(async()=>{
  try {
    const map = await loadCityMap();
    const pcm = await recordAudio();
    const text = await recognize(pcm);
    const m = text.match(/погода\s+в\s+(.+)/i);
    if(!m) throw new Error('Phrase "погода в" not found');
    const cityRaw = m[1].replace(/[?.!]*$/,'').trim();
    // normalize for map key
    let key = cityRaw.toLowerCase();
    if (key.endsWith('е')) key = key.slice(0,-1);
    const cityNorm = map[key] || cityRaw;
    console.log('City normalized:', cityNorm);
    const coords = await geocode(cityRaw, map);
    const w = await fetchWeather(coords);
    const reply = `Погода в ${cityNorm}: ${w.description}, ${w.temp}°C.`;
    const wav = await synthesize(reply);
    await playWav(wav);
  } catch(e) {
    console.error('!!! Error:', e.message);
  }
})();
