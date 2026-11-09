'use strict';
// Runs after `npm install`. The electron npm package (44.x) no longer downloads its binary while it is being installed,
// so fetch it with Electron's own installer whenever the binary is missing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const binary = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

if (fs.existsSync(electronDir) && !fs.existsSync(binary)) {
  console.log('Downloading the Electron binary...');
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
}
