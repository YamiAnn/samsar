import { describe, expect, it } from 'vitest';
import { getRenderableImageUrl } from '../../src/utils/image.jsx';

const processorUrl = 'https://api.samsar.one/';

describe('private image URL credentials', () => {
  it.each(['assets', 'assets_v2'])(
    'preserves media credentials when rewriting static %s images',
    (folder) => {
      const assetPath = `/${folder}/users/session/image.png`;
      const credential = '?asset_token=v1.owner%2Bsignature&variant=preview#frame';
      expect(getRenderableImageUrl(
        `https://static.samsar.one${assetPath}${credential}`,
        processorUrl,
      )).toBe(`https://api.samsar.one${assetPath}${credential}`);
    },
  );

  it.each(['assets', 'assets_v2', 'generations'])(
    'preserves credentials on relative %s paths',
    (folder) => {
      const path = `/${folder}/image.png?asset_token=v1.path.bound&variant=thumbnail`;
      expect(getRenderableImageUrl(path, processorUrl)).toBe(`https://api.samsar.one${path}`);
    },
  );

  it('keeps private preview URLs when an image has several source fields', () => {
    const previewUrl = '/assets_v2/users/session/preview.png?asset_token=v1.preview';
    expect(getRenderableImageUrl({ previewUrl, src: '/assets_v2/users/session/full.png' }, processorUrl))
      .toBe(`https://api.samsar.one${previewUrl}`);
  });

  it('keeps CloudFront signed URLs unchanged', () => {
    const url = 'https://static.samsar.one/assets_v2/users/session/image.png'
      + '?Expires=2000000000&Signature=cdn-signature&Key-Pair-Id=K123';
    expect(getRenderableImageUrl(url, processorUrl)).toBe(url);
  });

  it('keeps external, data, and blob images unchanged', () => {
    for (const url of [
      'https://images.example/image.png?asset_token=external',
      'data:image/png;base64,AAA',
      'blob:https://studio.samsar.one/image-id',
    ]) {
      expect(getRenderableImageUrl(url, processorUrl)).toBe(url);
    }
  });

  it('preserves explicit guest media routes', () => {
    const path = '/video_sessions/guest_media?sessionId=shared&assetKey=assets_v2%2Fshared%2Fimage.png';
    expect(getRenderableImageUrl(path, processorUrl)).toBe(`https://api.samsar.one${path}`);
  });

  it('supports same-origin media without a processor base URL', () => {
    const path = '/assets_v2/image.png?asset_token=v1.local';
    expect(getRenderableImageUrl(`https://static.samsar.one${path}`, '')).toBe(path);
  });

  it.each([
    ['legacy-image.png', '/generations/legacy-image.png'],
    ['legacy-image.png?variant=preview', '/generations/legacy-image.png?variant=preview'],
    ['/generations/image.png?asset_token=v1.generated', '/generations/image.png?asset_token=v1.generated'],
    ['/assets_v2/users/session/image.png?asset_token=v1.session', '/assets_v2/users/session/image.png?asset_token=v1.session'],
    ['https://api.samsar.one/generations/image.png?asset_token=v1.absolute', '/generations/image.png?asset_token=v1.absolute'],
  ])('generation completion resolves %s without adding a second prefix or query', (source, expectedPath) => {
    expect(getRenderableImageUrl(source, processorUrl, { legacyGenerationFilename: true }))
      .toBe(`https://api.samsar.one${expectedPath}`);
  });

  it('legacy generation fallback is explicit and supports same-origin delivery', () => {
    expect(getRenderableImageUrl('root-image.png', '')).toBe('/root-image.png');
    expect(getRenderableImageUrl('generated-image.png', '', { legacyGenerationFilename: true }))
      .toBe('/generations/generated-image.png');
  });
});
