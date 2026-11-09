'use strict';
// Runs after `npm install`. Recent npm versions (11.20+) no longer run dependencies' own install scripts by default,
// which leaves the `electron` package without its binary. Fetch it with Electron's own installer if it's missing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const binary = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

if (fs.existsSync(electronDir) && !fs.existsSync(binary)) {
  console.log('Downloading the Electron binary...');
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
}
