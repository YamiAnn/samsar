import { act, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import StepImageReviewPanel from '../../src/components/oneshot_editor/StepImageReviewPanel.jsx';

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>')}`;
const preview = { layers: [
  { id: 'one', image: { items: [
    { id: 'primary', isPrimary: true, src: '/primary.png', url: image, prompt: 'Mountain sunrise', width: 1280, height: 720 },
    { id: 'alternate', src: '/alternate.png', url: image, prompt: 'Mountain sunset' },
  ] } },
  { id: 'two', image: { url: image, prompt: 'Distant shore' } },
] };

describe('image review user actions in Chromium', () => {
  it('decodes the real image candidate in Chromium', async () => {
    render(<StepImageReviewPanel sessionPreview={preview} />);
    const picture = document.querySelector('img');
    await expect.poll(() => picture.naturalWidth).toBe(80);
    expect(picture.naturalHeight).toBe(40);
  });

  it('edits a candidate prompt and sends its scene and primary status for regeneration', async () => {
    const onRegenerateImage = vi.fn();
    render(<StepImageReviewPanel sessionPreview={preview} onRegenerateImage={onRegenerateImage} />);
    await page.getByRole('textbox').first().fill('A cloudless mountain sunrise');
    await page.getByRole('button', { name: 'Generate', exact: true }).first().click();
    expect(onRegenerateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      prompt: 'A cloudless mountain sunrise', isPrimary: true,
      scene: expect.objectContaining({ id: 'one' }), item: expect.objectContaining({ id: 'primary' }),
    }));
  });

  it('preserves prompt edits across scene switching', async () => {
    render(<StepImageReviewPanel sessionPreview={preview} colorMode="dark" />);
    await page.getByRole('textbox').first().fill('Unsaved first-scene revision');
    await page.getByRole('button', { name: 'Scene 2', exact: true }).click();
    await expect.element(page.getByRole('textbox')).toHaveValue('Distant shore');
    await page.getByRole('button', { name: 'Scene 1', exact: true }).click();
    await expect.element(page.getByRole('textbox').first()).toHaveValue('Unsaved first-scene revision');
  });

  it('rejects blank prompt regeneration while allowing alternate selection', async () => {
    render(<StepImageReviewPanel sessionPreview={preview} />);
    await page.getByRole('textbox').nth(1).fill('   ');
    await expect.element(page.getByRole('button', { name: 'Generate', exact: true }).nth(1)).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Use as primary' })).toBeEnabled();
  });

  it('selects an alternate as primary with deterministic layer IDs and original canvas dimensions', async () => {
    const onSelectImage = vi.fn();
    render(<StepImageReviewPanel sessionPreview={preview} onSelectImage={onSelectImage} />);
    await page.getByRole('button', { name: 'Use as primary' }).click();
    expect(onSelectImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      activeItemList: [
        expect.objectContaining({ id: 'item_0', src: '/alternate.png', is_base_image: true, width: 1280, height: 720 }),
        expect.objectContaining({ id: 'item_1', src: '/primary.png', is_base_image: false }),
      ],
    }));
  });

  it('blocks duplicate selection and regeneration during a pending save', async () => {
    let finish;
    render(<StepImageReviewPanel sessionPreview={preview}
      onSelectImage={() => new Promise(resolve => { finish = resolve; })} />);
    await page.getByRole('button', { name: 'Use as primary' }).click();
    await expect.element(page.getByRole('button', { name: 'Use as primary' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Generate', exact: true }).first()).toBeDisabled();
    await act(async () => finish());
    await expect.element(page.getByRole('button', { name: 'Use as primary' })).toBeEnabled();
  });
});
