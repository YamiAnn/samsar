import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StepImageReviewPanel from '../../src/components/oneshot_editor/StepImageReviewPanel.jsx';

const picture = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/%3E';
const primary = { id: 'original', url: picture, src: '/original.png', prompt: 'Original prompt',
  isPrimary: true, x: 10, y: 20, width: 1280, height: 720, animations: [{ type: 'zoom' }] };
const alternate = { item_id: 'alternate', url: picture, raw_url: '/alternate.png',
  generationPrompt: 'Alternate prompt', description: 'Night sky' };
const session = { layers: [
  { id: 'scene-a', prompt: 'Scene prompt', image: { items: [primary, alternate] } },
  { id: 'scene-b', image: { url: picture, rawUrl: '/second.png', prompt: 'Second prompt' } },
] };
function review(props = {}) {
  return render(<StepImageReviewPanel sessionPreview={session} colorMode="dark" {...props} />);
}

describe('step image review contracts', () => {
  it.each([undefined, null, {}, { layers: [] }, { layers: 'invalid' }, { layers: [{ image: {} }] }])
    ('does not show an empty review (%s)', sessionPreview => {
      const { container } = review({ sessionPreview });
      expect(container).toBeEmptyDOMElement();
    });

  it('shows one primary and one alternate and preserves their distinct prompts', () => {
    review();
    expect(screen.getByAltText('Scene 1 primary')).toHaveAttribute('src', picture);
    expect(screen.getByAltText('Scene 1 alternate')).toHaveAttribute('src', picture);
    expect(screen.getAllByRole('textbox').map(input => input.value)).toEqual(['Original prompt', 'Alternate prompt']);
    expect(screen.getByText('2 images')).toBeInTheDocument();
  });

  it('persists alternate selection first and renumbers canvas IDs without losing framing and animation', async () => {
    const onSelectImage = vi.fn();
    review({ onSelectImage });
    fireEvent.click(screen.getByRole('button', { name: 'Use as primary' }));
    await waitFor(() => expect(onSelectImage).toHaveBeenCalledOnce());
    const payload = onSelectImage.mock.calls[0][0];
    expect(payload.scene.id).toBe('scene-a');
    expect(payload.item.itemId).toBe('alternate');
    expect(payload.activeItemList).toEqual([
      { id: 'item_0', type: 'image', src: '/alternate.png', image: '/alternate.png',
        x: 10, y: 20, width: 1280, height: 720, is_base_image: true,
        prompt: 'Alternate prompt', generationPrompt: 'Alternate prompt', description: 'Night sky', animations: [{ type: 'zoom' }] },
      { id: 'item_1', type: 'image', src: '/original.png', image: '/original.png',
        x: 10, y: 20, width: 1280, height: 720, is_base_image: false,
        prompt: 'Original prompt', generationPrompt: 'Original prompt', animations: [{ type: 'zoom' }] },
    ]);
  });

  it('disables all actions during selection and enables them after it resolves', async () => {
    let finish;
    const onSelectImage = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    review({ onSelectImage });
    fireEvent.click(screen.getByRole('button', { name: 'Use as primary' }));
    screen.getAllByRole('button', { name: /Use as primary|Generate/ }).forEach(button => expect(button).toBeDisabled());
    await act(async () => finish());
    screen.getAllByRole('button', { name: /Use as primary|Generate/ }).forEach(button => expect(button).toBeEnabled());
  });

  it.each([0, 1])('regenerates image %s with its edited prompt and correct primary flag', async index => {
    const onRegenerateImage = vi.fn();
    review({ onRegenerateImage });
    fireEvent.change(screen.getAllByRole('textbox')[index], { target: { value: 'A newly edited prompt' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate', exact: true })[index]);
    await waitFor(() => expect(onRegenerateImage).toHaveBeenCalledOnce());
    expect(onRegenerateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'A newly edited prompt', isPrimary: index === 0,
      scene: expect.objectContaining({ id: 'scene-a' }),
    }));
  });

  it('blocks whitespace prompt regeneration without blocking alternate selection', () => {
    review();
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: '  \n ' } });
    expect(screen.getAllByRole('button', { name: 'Generate', exact: true })[1]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use as primary' })).toBeEnabled();
  });

  it('retains independent prompt drafts when switching scenes', () => {
    review();
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Scene one draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scene 2' }));
    expect(screen.getByRole('textbox')).toHaveValue('Second prompt');
    expect(screen.getByText('No alternate images yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Scene two draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scene 1' }));
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Scene one draft');
    fireEvent.click(screen.getByRole('button', { name: 'Scene 2' }));
    expect(screen.getByRole('textbox')).toHaveValue('Scene two draft');
  });

  it('returns to the first scene when the selected scene is removed by a server refresh', () => {
    const { rerender } = review();
    fireEvent.click(screen.getByRole('button', { name: 'Scene 2' }));
    rerender(<StepImageReviewPanel sessionPreview={{ layers: [session.layers[0]] }} colorMode="light" />);
    expect(screen.getByAltText('Scene 1 primary')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Original prompt');
  });

  it('promotes the first valid item when no primary marker is supplied and filters empty candidates', () => {
    review({ sessionPreview: { layers: [{ layer_id: 'fallback', prompt: 'Inherited prompt', image: {
      items: [{ id: 'missing' }, { itemId: 'valid', url: picture }],
    } }] } });
    expect(screen.getByAltText('Scene 1 primary')).toHaveAttribute('src', picture);
    expect(screen.getByRole('textbox')).toHaveValue('Inherited prompt');
    expect(screen.getByText('1 image')).toBeInTheDocument();
  });

  it('uses the edited image URL for the primary while preserving alternate candidates', () => {
    review({ sessionPreview: { layers: [{ ...session.layers[0], image: {
      items: [primary, alternate], editedImage: '/edited-preview.png', editedImageRawUrl: '/edited-raw.png',
    } }] } });
    expect(screen.getByAltText('Scene 1 primary')).toHaveAttribute('src', '/edited-preview.png');
    expect(screen.getByAltText('Scene 1 alternate')).toHaveAttribute('src', picture);
  });

  it('locks regeneration actions until the request completes', async () => {
    let finish;
    review({ onRegenerateImage: () => new Promise(resolve => { finish = resolve; }) });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate', exact: true })[0]);
    expect(screen.getByRole('button', { name: 'Use as primary' })).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole('button', { name: 'Use as primary' })).toBeEnabled();
  });

  it.each(['src', 'rawUrl', 'raw_url', 'image', 'remoteURL'])('renders a raw-only %s candidate accepted by the review model', field => {
    review({ sessionPreview: { layers: [{ id: 'raw-only', image: { items: [{ id: 'a', [field]: '/raw-only.png' }] } }] } });
    expect(screen.getByAltText('Scene 1 primary')).toHaveAttribute('src', '/raw-only.png');
  });
});
