// test_mic.js
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Mic = require('mic');

// Параметры записи — 24 кГц, 16-бит, моно, дефолтное устройство
const micInstance = Mic({
  rate: '24000',
  channels: '1',
  bitwidth: '16',
  encoding: 'signed-integer',
  device: 'default'
});

const micStream = micInstance.getAudioStream();
const outFile   = fs.createWriteStream('test.raw');

micStream.pipe(outFile);

micStream.on('error', (err) => {
  console.error('Ошибка микрофона:', err);
});

console.log('Запись 5 секунд… говорите!');
micInstance.start();

setTimeout(() => {
  micInstance.stop();
  console.log('Остановлено, файл test.raw готов.');
}, 5000);
