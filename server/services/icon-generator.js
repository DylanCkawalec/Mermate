'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ICON = path.join(PROJECT_ROOT, 'public', 'mermate-icon.png');

const DALLE_API_KEY = process.env.DALLE_API_KEY || process.env.OPENAI_API_KEY || '';
const IMAGE_MODEL = process.env.MERMATE_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_BASE = 'https://api.openai.com/v1';

// ---- OpenAI Images API wrapper ------------------------------------------------

async function _generateImage(prompt, { size = '1024x1024', quality = 'medium', background = 'auto' } = {}) {
  if (!DALLE_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DALLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        n: 1,
        size,
        quality,
        background,
        output_format: 'png',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn('icon_gen.api_error', { status: res.status, body: errBody.slice(0, 300) });
      return null;
    }

    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      logger.warn('icon_gen.no_image_data');
      return null;
    }

    return Buffer.from(b64, 'base64');
  } catch (err) {
    logger.warn('icon_gen.request_failed', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function generateIcon(outputDir, diagramName, { entities = [], description = '' } = {}) {
  await fsp.mkdir(outputDir, { recursive: true });
  const iconPath = path.join(outputDir, 'icon.png');

  const entityNames = entities.slice(0, 6).map(e => e.name || e).join(', ');
  const prompt = `A modern, clean macOS application icon for "${diagramName}". ` +
    `The icon represents a software architecture system${entityNames ? ` involving ${entityNames}` : ''}. ` +
    `${description ? `System purpose: ${description.slice(0, 200)}. ` : ''}` +
    `Style: minimal flat design, bold geometric shapes, subtle gradient, professional developer tool aesthetic. ` +
    `Single centered glyph on a rounded-square background. No text. No photography. Clean vector look.`;

  logger.info('icon_gen.generating', { diagramName, model: IMAGE_MODEL, prompt: prompt.slice(0, 120) + '...' });

  const iconBuf = await _generateImage(prompt, { size: '1024x1024', quality: 'medium', background: 'opaque' });

  if (iconBuf) {
    await fsp.writeFile(iconPath, iconBuf);
    logger.info('icon_gen.generated', { diagramName, bytes: iconBuf.length, path: iconPath });
  } else {
    try {
      await fsp.copyFile(DEFAULT_ICON, iconPath);
      logger.info('icon_gen.fallback_default', { diagramName });
    } catch {
      logger.warn('icon_gen.no_icon');
    }
  }

  return iconPath;
}

async function generateHeroImage(outputDir, diagramName, { entities = [], description = '' } = {}) {
  const heroPath = path.join(outputDir, 'hero.png');

  const entityNames = entities.slice(0, 8).map(e => e.name || e).join(', ');
  const prompt = `A wide hero banner image for the "${diagramName}" architecture dashboard. ` +
    `Shows an abstract visualization of a distributed system${entityNames ? ` with components: ${entityNames}` : ''}. ` +
    `${description ? `Purpose: ${description.slice(0, 200)}. ` : ''}` +
    `Style: dark mode, deep navy/charcoal background, glowing cyan and violet node connections, ` +
    `flowing data streams between abstract geometric nodes. Modern tech aesthetic. No text. Widescreen.`;

  const heroBuf = await _generateImage(prompt, { size: '1536x1024', quality: 'medium', background: 'opaque' });

  if (heroBuf) {
    await fsp.writeFile(heroPath, heroBuf);
    logger.info('icon_gen.hero_generated', { diagramName, bytes: heroBuf.length });
    return heroPath;
  }

  return null;
}

// ---- macOS .app bundle --------------------------------------------------------

async function createMacOSApp(binaryPath, iconPath, appName, outputDir, { launcherScript } = {}) {
  if (process.platform !== 'darwin') return null;

  try {
    await fsp.access(binaryPath);
  } catch {
    logger.warn('icon_gen.app_bundle_skip', { reason: 'binary_missing', binaryPath });
    return null;
  }

  const appDir = path.join(outputDir, `${appName}.app`);
  const contentsDir = path.join(appDir, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');

  try {
    await fsp.mkdir(macosDir, { recursive: true });
    await fsp.mkdir(resourcesDir, { recursive: true });

    if (launcherScript) {
      await fsp.writeFile(path.join(macosDir, appName), launcherScript, { mode: 0o755 });
    } else {
      await fsp.copyFile(binaryPath, path.join(macosDir, appName));
      await fsp.chmod(path.join(macosDir, appName), 0o755);
    }

    await fsp.copyFile(binaryPath, path.join(macosDir, `${appName}-engine`));
    await fsp.chmod(path.join(macosDir, `${appName}-engine`), 0o755);

    if (iconPath) {
      await fsp.copyFile(iconPath, path.join(resourcesDir, 'icon.png')).catch(() => {});
    }

    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>CFBundleName</key><string>${appName}</string>`,
      `  <key>CFBundleDisplayName</key><string>${appName}</string>`,
      `  <key>CFBundleIdentifier</key><string>com.mermate.${appName.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}</string>`,
      '  <key>CFBundleVersion</key><string>1.0.0</string>',
      `  <key>CFBundleExecutable</key><string>${appName}</string>`,
      '  <key>CFBundleIconFile</key><string>icon.png</string>',
      '  <key>LSMinimumSystemVersion</key><string>12.0</string>',
      '  <key>NSHighResolutionCapable</key><true/>',
      '</dict>',
      '</plist>',
    ].join('\n');

    await fsp.writeFile(path.join(contentsDir, 'Info.plist'), plist, 'utf8');

    logger.info('icon_gen.app_bundle_created', { appName, path: appDir });
    return appDir;
  } catch (err) {
    logger.warn('icon_gen.app_bundle_failed', { error: err.message });
    return null;
  }
}

// ---- Desktop deployment -------------------------------------------------------

async function deployToDesktop(appBundlePath, binaryPath, appName) {
  const os = require('node:os');
  const desktop = path.join(os.homedir(), 'Desktop');

  try { await fsp.access(desktop); } catch { return null; }

  if (appBundlePath && process.platform === 'darwin') {
    const dest = path.join(desktop, `${appName}.app`);
    try {
      await fsp.rm(dest, { recursive: true, force: true });
      await _copyDir(appBundlePath, dest);
      logger.info('icon_gen.deployed_app', { dest });
      return dest;
    } catch (err) {
      logger.warn('icon_gen.deploy_app_failed', { error: err.message });
    }
  }

  if (binaryPath) {
    const dest = path.join(desktop, appName);
    try {
      await fsp.copyFile(binaryPath, dest);
      await fsp.chmod(dest, 0o755);
      logger.info('icon_gen.deployed_binary', { dest });
      return dest;
    } catch (err) {
      logger.warn('icon_gen.deploy_binary_failed', { error: err.message });
    }
  }

  return null;
}

async function _copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await _copyDir(s, d);
    else {
      await fsp.copyFile(s, d);
      const stat = await fsp.stat(s);
      if (stat.mode & 0o111) await fsp.chmod(d, stat.mode);
    }
  }));
}

module.exports = { generateIcon, generateHeroImage, createMacOSApp, deployToDesktop };
