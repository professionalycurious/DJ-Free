// Copies the shared web UI from the Android project into desktop/www.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'www');
const dst = path.join(__dirname, '..', 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('copied web UI ->', dst);
