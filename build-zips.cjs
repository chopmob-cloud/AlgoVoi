/**
 * Build store zip files using adm-zip (produces POSIX forward-slash paths).
 * PowerShell Compress-Archive uses backslashes — rejected by Chrome Web Store.
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

function addDirToZip(zip, dirPath, zipBase) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = (zipBase ? zipBase + '/' + entry.name : entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      addDirToZip(zip, fullPath, zipPath);
    } else {
      zip.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
}

// ── Chrome zip (from dist/) ───────────────────────────────────────────────────
const chrome = new AdmZip();
addDirToZip(chrome, 'dist', '');
chrome.writeZip('algovoi-1.0.2-chrome.zip');
console.log('✓ algovoi-1.0.2-chrome.zip');

// ── Firefox dist (patch manifest, remove sidepanel) ───────────────────────────
if (!fs.existsSync('dist-firefox')) {
  fs.cpSync('dist', 'dist-firefox', { recursive: true });
  const mf = JSON.parse(fs.readFileSync('dist-firefox/manifest.json', 'utf-8'));
  if (mf.background?.service_worker) {
    mf.background = { scripts: [mf.background.service_worker], type: 'module' };
  }
  mf.browser_specific_settings = {
    gecko: { id: 'algovoi@chopmob.cloud', strict_min_version: '128.0' },
  };
  delete mf.side_panel;
  const sideIdx = (mf.permissions || []).indexOf('sidePanel');
  if (sideIdx !== -1) mf.permissions.splice(sideIdx, 1);
  fs.writeFileSync('dist-firefox/manifest.json', JSON.stringify(mf, null, 2));
  fs.rmSync('dist-firefox/src/sidepanel', { recursive: true, force: true });
}

// ── Firefox zip (from dist-firefox/) ─────────────────────────────────────────
const firefox = new AdmZip();
addDirToZip(firefox, 'dist-firefox', '');
firefox.writeZip('algovoi-1.0.2-firefox.zip');
console.log('✓ algovoi-1.0.2-firefox.zip');

// ── Source zip (for AMO — everything except node_modules and dist) ────────────
const EXCLUDE = new Set(['node_modules', 'dist', 'dist-firefox', '.git', 'packages',
  'algovoi-1.0.2-chrome.zip', 'algovoi-1.0.2-firefox.zip', 'algovoi-1.0.2-source.zip']);

function addSourceDir(zip, dirPath, zipBase) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = (zipBase ? zipBase + '/' + entry.name : entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      addSourceDir(zip, fullPath, zipPath);
    } else {
      zip.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
}

const source = new AdmZip();
addSourceDir(source, '.', '');
source.writeZip('algovoi-1.0.2-source.zip');
console.log('✓ algovoi-1.0.2-source.zip');
