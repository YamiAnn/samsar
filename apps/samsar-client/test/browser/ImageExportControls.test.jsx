import { useState } from 'react';
import { render } from '@testing-library/react';
import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import ImageDownloadDialog from '../../src/components/image/ImageDownloadDialog.jsx';
import ImagePayloadAspectRatioSelector from '../../src/components/image/ImagePayloadAspectRatioSelector.jsx';
import { ColorModeProvider } from '../../src/contexts/ColorMode.jsx';

const options = [
  { value: '1:1', label: 'Square' }, { value: '16:9', label: 'Landscape' },
  { value: '9:16', label: 'Portrait' }, { value: 'invalid', label: 'Custom' },
];
function downloadDialog(props = {}) {
  return render(<ColorModeProvider><ImageDownloadDialog baseWidth={1600} baseHeight={900} aspectRatio="16:9"
    aspectRatioOptions={options} onDownload={vi.fn()} onClose={vi.fn()} {...props} /></ColorModeProvider>);
}

describe('image export dimensions', () => {
  it.each([1, 2, 4])('exports the selected %sx scale with the displayed output size', async scale => {
    const onDownload = vi.fn();
    downloadDialog({ onDownload });
    await page.getByRole('button', { name: `${scale}x`, exact: true }).click();
    await expect.element(page.getByText(`Output: ${1600 * scale} × ${900 * scale}px`)).toBeVisible();
    await page.getByRole('button', { name: 'Download Scaled Image' }).click();
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({ mode: 'scale', scale });
  });

  it('keeps the ratio when width changes and sends the resulting crop dimensions', async () => {
    const onDownload = vi.fn();
    downloadDialog({ onDownload });
    await page.getByRole('spinbutton').first().fill('800');
    await expect.element(page.getByRole('spinbutton').nth(1)).toHaveValue(450);
    await page.getByRole('button', { name: 'Download Custom Image' }).click();
    expect(onDownload).toHaveBeenCalledWith({ mode: 'custom', width: 800, height: 450, crop: true });
  });

  it('keeps the ratio when height changes', async () => {
    downloadDialog();
    await page.getByRole('spinbutton').nth(1).fill('180');
    await expect.element(page.getByRole('spinbutton').first()).toHaveValue(320);
  });

  it('recomputes height when the preset changes while ratio lock is enabled', async () => {
    downloadDialog();
    await page.getByRole('combobox').selectOptions('1:1');
    await expect.element(page.getByRole('spinbutton').nth(1)).toHaveValue(1600);
  });

  it('allows independent width, height and preset changes with ratio unlocked', async () => {
    const onDownload = vi.fn();
    downloadDialog({ onDownload });
    await page.getByRole('checkbox', { name: 'Lock ratio' }).click();
    await page.getByRole('spinbutton').first().fill('777');
    await expect.element(page.getByRole('spinbutton').nth(1)).toHaveValue(900);
    await page.getByRole('spinbutton').nth(1).fill('555');
    await page.getByRole('combobox').selectOptions('9:16');
    await page.getByRole('button', { name: 'Download Custom Image' }).click();
    expect(onDownload).toHaveBeenCalledWith({ mode: 'custom', width: 777, height: 555, crop: true });
  });

  it.each(['', '0', '-5'])('blocks custom export with invalid width %s', async width => {
    downloadDialog();
    await page.getByRole('spinbutton').first().fill(width);
    await expect.element(page.getByRole('button', { name: 'Download Custom Image' })).toBeDisabled();
  });

  it('does not rewrite the other dimension for an invalid ratio', async () => {
    downloadDialog();
    await page.getByRole('combobox').selectOptions('invalid');
    await page.getByRole('spinbutton').first().fill('123');
    await expect.element(page.getByRole('spinbutton').nth(1)).toHaveValue(900);
  });

  it('closes without requesting a download', async () => {
    const onClose = vi.fn(); const onDownload = vi.fn();
    downloadDialog({ onClose, onDownload });
    await page.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledOnce(); expect(onDownload).not.toHaveBeenCalled();
  });
});

describe('generation aspect ratio selector', () => {
  it.each([
    [{ width: 1792, height: 1024 }, '16:9', 'Canvas 1792 x 1024 px'],
    [{ width: 1024, height: 1792 }, '16:9', 'Canvas 1024 x 1792 px, preset Portrait'],
    [{ width: 733, height: 601 }, '1:1', 'Custom canvas 733 x 601 px'],
  ])('describes the actual canvas independently of generation ratio', async (canvasDimensions, value, helper) => {
    render(<ImagePayloadAspectRatioSelector value={value} canvasDimensions={canvasDimensions} options={options} compactInline sizeVariant="imageStudio" />);
    await expect.element(page.getByText(helper, { exact: true })).toBeVisible();
  });

  it('updates a controlled ratio using the real select', async () => {
    function Selector() {
      const [value, onChange] = useState('1:1');
      return <ImagePayloadAspectRatioSelector value={value} onChange={onChange} options={options} />;
    }
    render(<Selector />);
    await page.getByRole('combobox').selectOptions('9:16');
    await expect.element(page.getByRole('combobox')).toHaveValue('9:16');
  });
});
