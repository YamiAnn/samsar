import { useState } from 'react';
import { render } from '@testing-library/react';
import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import ImageLayersPanel from '../../src/components/image/ImageLayersPanel.jsx';
import { ColorModeProvider } from '../../src/contexts/ColorMode.jsx';

const initialItems = [
  { id: 'bg', type: 'shape', subType: 'background', config: { fixed: true } },
  { id: 'photo', type: 'image' },
  { id: 'caption', type: 'text', text: '  The last night beneath the stars  ' },
];

function Layers({ items = initialItems, selected = 'caption', persist = vi.fn(), visibility = vi.fn(), ...props }) {
  const [activeItemList, setActiveItemList] = useState(items);
  const [selectedId, setSelectedId] = useState(selected);
  return <ColorModeProvider>
    <ImageLayersPanel activeItemList={activeItemList} setActiveItemList={setActiveItemList}
      selectedId={selectedId} setSelectedId={setSelectedId} updateSessionLayerActiveItemList={persist}
      onToggleItemVisibility={visibility} {...props} />
    <output aria-label="Selected layer">{selectedId || 'none'}</output>
  </ColorModeProvider>;
}

describe('image layer editing in Chromium', () => {
  it('displays the topmost item first and truncates long text labels', async () => {
    const { container } = render(<Layers />);
    const rows = [...container.querySelectorAll('[data-rbd-draggable-id]')];
    expect(rows.map(row => row.getAttribute('data-rbd-draggable-id'))).toEqual(['caption', 'photo', 'bg']);
    await expect.element(page.getByText('Text: The last night beneath the...')).toBeVisible();
    await expect.element(page.getByText('Background', { exact: true })).toBeVisible();
  });

  it.each([null, [], 'invalid'])('handles an empty or invalid list (%s) and collapses it', async (items) => {
    render(<Layers items={items} />);
    await expect.element(page.getByText('No layers yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Layers 0' }).click();
    await expect.element(page.getByText('No layers yet.')).not.toBeInTheDocument();
    await page.getByRole('button', { name: 'Layers 0' }).click();
    await expect.element(page.getByText('No layers yet.')).toBeVisible();
  });

  it('selects a layer without changing persisted items', async () => {
    const persist = vi.fn();
    render(<Layers persist={persist} />);
    await page.getByText('Image 2', { exact: true }).click();
    await expect.element(page.getByLabelText('Selected layer')).toHaveTextContent('photo');
    expect(persist).not.toHaveBeenCalled();
  });

  it('deletes the selected layer, renumbers remaining IDs and clears selection', async () => {
    const persist = vi.fn();
    render(<Layers persist={persist} />);
    await page.getByRole('button', { name: 'Delete layer' }).first().click();
    expect(persist).toHaveBeenCalledWith([
      { ...initialItems[0], id: 'item_0' }, { ...initialItems[1], id: 'item_1' },
    ]);
    await expect.element(page.getByLabelText('Selected layer')).toHaveTextContent('none');
    await expect.element(page.getByRole('button', { name: 'Layers 2' })).toBeVisible();
  });

  it('preserves the selection when a lower item is deleted and its ID changes', async () => {
    const persist = vi.fn();
    render(<Layers persist={persist} />);
    await page.getByRole('button', { name: 'Delete layer' }).nth(1).click();
    await expect.element(page.getByLabelText('Selected layer')).toHaveTextContent('item_1');
    expect(persist.mock.calls[0][0].map(item => item.id)).toEqual(['item_0', 'item_1']);
  });

  it.each([false, true])('toggles visibility without selecting or saving the layer (hidden=%s)', async (isHidden) => {
    const persist = vi.fn();
    const visibility = vi.fn();
    render(<Layers items={[{ id: 'photo', type: 'image', isHidden }]} selected="another" persist={persist} visibility={visibility} />);
    await page.getByRole('button', { name: isHidden ? 'Show layer' : 'Hide layer' }).click();
    expect(visibility).toHaveBeenCalledWith('photo');
    expect(persist).not.toHaveBeenCalled();
    await expect.element(page.getByLabelText('Selected layer')).toHaveTextContent('another');
  });

  it('uses shape, blank text and unknown layer fallback labels', async () => {
    render(<Layers items={[
      { id: 'empty-text', type: 'text', text: '   ' },
      { id: 'circle', type: 'shape', shape: 'circle' },
      { id: 'unknown', type: 'custom' },
      { id: 'generic', type: 'shape' },
    ]} sizeVariant="imageStudio" />);
    await expect.element(page.getByText('Text 1', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Circle 2', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Layer 3', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Shape 4', { exact: true })).toBeVisible();
  });

  it('reorders with the native drag handle keyboard interaction and tracks selection', async () => {
    const persist = vi.fn();
    render(<Layers persist={persist} />);
    await page.getByRole('button', { name: 'Reorder layer' }).first().click();
    await userEvent.keyboard(' ');
    const dragged = () => document.querySelector('[data-rbd-draggable-id="caption"]');
    await expect.poll(() => dragged().style.position).toBe('fixed');
    const initialTransform = dragged().style.transform;
    await userEvent.keyboard('{ArrowDown}');
    await expect.poll(() => dragged().style.transform).not.toBe(initialTransform);
    await userEvent.keyboard(' ');
    await expect.poll(() => persist.mock.calls.length).toBe(1);
    expect(persist.mock.calls[0][0].map(item => item.type)).toEqual(['shape', 'text', 'image']);
    await expect.element(page.getByLabelText('Selected layer')).toHaveTextContent('item_1');
  });
});
