import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the public media gateway cannot bypass processor authorization with a raw volume', () => {
  const gateway = read('deploy/compose/media-gateway.conf');
  assert.doesNotMatch(gateway, /\b(?:alias|root|try_files)\s/);
  assert.match(gateway, /assets\|assets_v2\|generations/);
  assert.match(gateway, /http:\/\/processor:3002/);
  assert.match(gateway, /proxy_pass \$asset_processor\$request_uri;/);
  assert.match(gateway, /location \/ \{ return 404; \}/);
  const service = read('deploy/compose/docker-compose.yml').split('  media-gateway:\n')[1]?.split('\n  ')[0];
  assert.ok(service);
  assert.doesNotMatch(service, /media-assets|usr\/share\/nginx\/html/);
});

test('processor mounts the ownership policy on both private roots and signs authenticated JSON media', () => {
  const app = read('services/processor/app.js');
  assert.match(app, /installPrivateAssetAccess\(\{[\s\S]*?assetsPath,[\s\S]*?assetsV2Path,[\s\S]*?resolveActor: resolveRequestActorFromAuthHeaders,[\s\S]*?canAccessAsset: canAccessPrivateAsset,/);
  assert.doesNotMatch(app, /express\.static\(assets(?:V2)?Path/);
  assert.ok(app.indexOf('app.use(privateAssetResponseMiddleware(') < app.indexOf("app.use('/users'"));
  assert.match(read('services/processor/package.json'), /test:credits-security/);
  assert.match(read('services/processor/package.json'), /test:assets-security/);
});

test('generated public font previews remain separate from private media roots', () => {
  const source = read('services/processor/src/utils/SupportedFontSamples.js');
  assert.match(source, /'public_assets', 'supported_fonts'/);
  const app = read('services/processor/app.js');
  assert.match(app, /app\.use\('\/supported_fonts'/);
  assert.match(app, /isSupportedFontSamplePath\(req.path\)/);
});
