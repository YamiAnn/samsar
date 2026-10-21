import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSupportedFontSamplePath,
  resolveSupportedFontSamplesDirectory,
} from './SupportedFontSamples.js';
import { SUPPORTED_SUBTITLE_FONTS_BY_LANGUAGE } from '../consts/SubtitleFonts.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

test('default font previews are generated outside private asset folders', () => {
  assert.equal(
    resolveSupportedFontSamplesDirectory({}),
    path.join(projectRoot, 'public_assets', 'supported_fonts'),
  );
});

test('a separate public output directory can be configured', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-public-fonts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'public', 'supported_fonts');
  assert.equal(resolveSupportedFontSamplesDirectory({
    FONT_SAMPLE_OUTPUT_DIR: outputDir,
    SAMSAR_ASSETS_ROOT: path.join(root, 'private', 'assets'),
    SAMSAR_ASSETS_V2_ROOT: path.join(root, 'private', 'assets_v2'),
  }), outputDir);
});

test('default private folders and their children cannot become public font output', () => {
  for (const privateRoot of [
    '/assets', '/assets_v2', path.join(projectRoot, 'assets'), path.join(projectRoot, 'assets_v2'),
  ]) {
    for (const outputDir of [privateRoot, path.join(privateRoot, 'supported_fonts')]) {
      assert.throws(() => resolveSupportedFontSamplesDirectory({ FONT_SAMPLE_OUTPUT_DIR: outputDir }),
        /must be separate from private assets/);
    }
  }
});

test('configured private roots cannot overlap the public directory in either direction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-font-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const key of ['SAMSAR_ASSETS_ROOT', 'SAMSAR_ASSETS_V2_ROOT']) {
    const privateRoot = path.join(root, 'private');
    for (const outputDir of [root, privateRoot, path.join(privateRoot, 'fonts')]) {
      assert.throws(() => resolveSupportedFontSamplesDirectory({
        [key]: privateRoot, FONT_SAMPLE_OUTPUT_DIR: outputDir,
      }), /must be separate from private assets/);
    }
  }
});

test('public directory symlinks cannot expose private media, including nonexistent child paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-font-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateRoot = path.join(root, 'private');
  fs.mkdirSync(privateRoot);
  const link = path.join(root, 'public-link');
  fs.symlinkSync(privateRoot, link, 'dir');
  for (const outputDir of [link, path.join(link, 'new-fonts')]) {
    assert.throws(() => resolveSupportedFontSamplesDirectory({
      SAMSAR_ASSETS_ROOT: privateRoot, FONT_SAMPLE_OUTPUT_DIR: outputDir,
    }), /must be separate from private assets/);
  }
});

test('private root aliases cannot overlap an apparently separate public directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-font-private-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actualRoot = path.join(root, 'actual');
  const privateAlias = path.join(root, 'private-alias');
  fs.mkdirSync(actualRoot);
  fs.symlinkSync(actualRoot, privateAlias, 'dir');
  assert.throws(() => resolveSupportedFontSamplesDirectory({
    SAMSAR_ASSETS_V2_ROOT: privateAlias,
    FONT_SAMPLE_OUTPUT_DIR: path.join(actualRoot, 'fonts'),
  }), /must be separate from private assets/);
});

test('the public font whitelist covers generated light, dark, and legacy sample paths', () => {
  for (const [language, fonts] of Object.entries(SUPPORTED_SUBTITLE_FONTS_BY_LANGUAGE)) {
    for (const fontName of fonts) {
      const slug = fontName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      for (const theme of ['', 'light/', 'dark/']) {
        assert.equal(isSupportedFontSamplePath(`${theme}${language}/${slug}.png`), true);
        assert.equal(isSupportedFontSamplePath(`/${theme}${language}/${slug}.png`), true);
      }
    }
  }
});

test('the public font route rejects arbitrary files, manifests, encodings, and traversal', () => {
  for (const value of [
    '', null, undefined, {},
    '/', 'light/', 'light/en/', '.font_samples_manifest.json', '.font_samples_manifest.lock',
    '/light/en/private.mp4', '/light/en/unknown_font.png', '/light/unknown/poppins.png',
    '/light/en/poppins.PNG', '/light/en/poppins.svg', '/light/en/poppins.png/extra',
    '//light/en/poppins.png', '/light/en/../en/poppins.png', '/light%2fen/poppins.png',
    '/light/%65n/poppins.png', '/assets/supported_fonts/light/en/poppins.png',
    '/light/en/poppins.png?file=private', '/light/en/poppins.png#fragment',
    '/light\\en\\poppins.png', '/light/en/poppins.png\0',
  ]) {
    assert.equal(isSupportedFontSamplePath(value), false, String(value));
  }
});
