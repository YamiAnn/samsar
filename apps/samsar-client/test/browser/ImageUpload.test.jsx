import { fireEvent, render, waitFor } from '@testing-library/react';
import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import ImageUploadDialog from '../../src/components/image/ImageUploadDialog.jsx';
import { ColorModeProvider } from '../../src/contexts/ColorMode.jsx';

function mount(props = {}, theme = 'dark') {
  localStorage.setItem('colorMode', theme);
  return render(<ColorModeProvider><ImageUploadDialog canvasDimensions={{ width: 512, height: 512 }} {...props} /></ColorModeProvider>);
}

function svgFile(name = 'wide.svg', width = 800, height = 400) {
  return new File([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`], name, { type: 'image/svg+xml' });
}

function choose(files) {
  // File selection is dispatched with real File objects so browser FileReader,
  // image decoding and object URLs execute, without an external media server.
  fireEvent.change(document.querySelector('#image-upload-input'), { target: { files } });
}

describe('image and video upload dialog', () => {
  it('fits a decoded image to the canvas and returns its centered placement', async () => {
    const uploaded = vi.fn();
    mount({ setUploadURL: uploaded });
    await page.elementLocator(document.querySelector('#image-upload-input')).upload(svgFile());
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
    expect(uploaded).toHaveBeenCalledWith({ url: expect.stringMatching(/^data:image\/svg\+xml;base64,/), width: 512, height: 256, x: 0, y: 128 });
    await expect.element(page.getByText('Upload successful! Added 1 image to canvas.')).toBeVisible();
    await expect.element(page.getByRole('img', { name: 'Preview' })).toBeVisible();
    expect(document.querySelector('#image-upload-input').value).toBe('');
  });

  it('does not upscale smaller images and uses explicit portrait canvas dimensions', async () => {
    const uploaded = vi.fn();
    mount({ setUploadURL: uploaded, aspectRatio: '9:16', canvasDimensions: { width: 400, height: 800 } }, 'light');
    choose([svgFile('small.svg', 200, 100)]);
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
    expect(uploaded).toHaveBeenCalledWith(expect.objectContaining({ width: 200, height: 100, x: 100, y: 350 }));
  });

  it('preserves selection order and returns an array for multiple images', async () => {
    const uploaded = vi.fn();
    mount({ setUploadURL: uploaded });
    choose([svgFile('wide.svg', 800, 400), svgFile('tall.svg', 400, 800)]);
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
    expect(uploaded).toHaveBeenCalledWith([
      expect.objectContaining({ width: 512, height: 256, x: 0, y: 128 }),
      expect.objectContaining({ width: 256, height: 512, x: 128, y: 0 }),
    ]);
    await expect.element(page.getByText('Upload successful! Added 2 images to canvas.')).toBeVisible();
    expect(document.querySelectorAll('img[alt="Preview"]')).toHaveLength(2);
  });

  it('limits visible thumbnails without dropping uploaded image placements', async () => {
    const uploaded = vi.fn();
    mount({ setUploadURL: uploaded });
    choose(Array.from({ length: 8 }, (_, i) => svgFile(`${i}.svg`, 80, 40)));
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
    expect(uploaded.mock.calls[0][0]).toHaveLength(8);
    expect(document.querySelectorAll('img[alt="Preview"]')).toHaveLength(6);
    await expect.element(page.getByText('+2', { exact: true })).toBeVisible();
  });

  it('rejects empty file selections and unsupported documents without emitting an upload', async () => {
    const uploaded = vi.fn();
    mount({ setUploadURL: uploaded });
    choose([]);
    await expect.element(page.getByText('Please upload an image file.')).toBeVisible();
    choose([new File(['text'], 'document.txt', { type: 'text/plain' })]);
    await expect.element(page.getByText('Please upload an image file.')).toBeVisible();
    expect(uploaded).not.toHaveBeenCalled();
  });

  it('reports decoding failures and allows selecting a valid image afterwards', async () => {
    const uploaded = vi.fn();
    mount({ setUploadURL: uploaded });
    choose([new File(['corrupt-image'], 'broken.png', { type: 'image/png' })]);
    await expect.element(page.getByText('Upload failed. Please try another image.')).toBeVisible();
    expect(uploaded).not.toHaveBeenCalled();
    choose([svgFile()]);
    await expect.element(page.getByText('Upload successful! Added 1 image to canvas.')).toBeVisible();
    expect(uploaded).toHaveBeenCalledOnce();
  });

  it('supports a preview even when the caller has no upload callback', async () => {
    mount();
    choose([svgFile()]);
    await expect.element(page.getByText('Upload successful! Added 1 image to canvas.')).toBeVisible();
  });

  it('shows drag feedback, clears it on leave, and consumes a real drop', async () => {
    const uploaded = vi.fn();
    const { container } = mount({ setUploadURL: uploaded });
    const zone = container.querySelector('.upload-container');
    fireEvent.dragOver(zone);
    await expect.element(page.getByText('Drop now', { exact: true })).toBeVisible();
    fireEvent.dragLeave(zone);
    await expect.element(page.getByText('Click or drag', { exact: true })).toBeVisible();
    const clearData = vi.fn();
    fireEvent.drop(zone, { dataTransfer: { files: [svgFile()], clearData } });
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
    expect(clearData).toHaveBeenCalledOnce();
  });

  it('accepts pasted image files and ignores text-only clipboard items', async () => {
    const uploaded = vi.fn();
    const { container } = mount({ setUploadURL: uploaded });
    const zone = container.querySelector('.upload-container');
    fireEvent.paste(zone, { clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }, { type: 'image/png', getAsFile: () => null }] } });
    expect(uploaded).not.toHaveBeenCalled();
    fireEvent.paste(zone, { clipboardData: { items: [{ type: 'image/svg+xml', getAsFile: () => svgFile() }] } });
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
  });

  it('rejects mixed image/video batches before reading media or submitting', async () => {
    const image = vi.fn();
    const video = vi.fn();
    mount({ setUploadURL: image, setUploadVideo: video });
    choose([svgFile(), new File(['video'], 'clip.mp4', { type: 'video/mp4' })]);
    await expect.element(page.getByText('Upload images or one video at a time.')).toBeVisible();
    expect(image).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
  });

  it('rejects multiple video selections including extension-only video files', async () => {
    const video = vi.fn();
    mount({ setUploadVideo: video });
    choose([new File(['a'], 'clip.MOV'), new File(['b'], 'other.webm')]);
    await expect.element(page.getByText('Please upload a single video file.')).toBeVisible();
    expect(video).not.toHaveBeenCalled();
  });

  it('rejects videos exceeding the 2 GB limit before creating object URLs', async () => {
    const video = vi.fn();
    mount({ setUploadVideo: video });
    const file = new File(['a'], 'large.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 * 1024 + 1 });
    choose([file]);
    await expect.element(page.getByText('Video uploads must be 2 GB or smaller.')).toBeVisible();
    await expect.element(page.getByText('Preparing uploaded video', { exact: true })).not.toBeInTheDocument();
    expect(video).not.toHaveBeenCalled();
  });

  it('reports unreadable video metadata and releases the processing overlay', async () => {
    const video = vi.fn();
    mount({ setUploadVideo: video });
    choose([new File(['invalid-mp4'], 'broken.mp4', { type: 'video/mp4' })]);
    await expect.element(page.getByText('Unable to read video metadata.')).toBeVisible();
    await expect.element(page.getByText('Preparing uploaded video', { exact: true })).not.toBeInTheDocument();
    expect(video).not.toHaveBeenCalled();
  });

  it('rejects a video when the consumer only accepts images', async () => {
    const image = vi.fn();
    mount({ setUploadURL: image });
    choose([new File(['a'], 'clip.mp4', { type: 'video/mp4' })]);
    await expect.element(page.getByText('Please upload an image file.')).toBeVisible();
    expect(image).not.toHaveBeenCalled();
    expect(document.querySelector('#image-upload-input').accept).not.toContain('video/');
  });
});
