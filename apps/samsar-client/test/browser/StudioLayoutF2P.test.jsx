import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { page } from 'vitest/browser';
import { expect, it, vi } from 'vitest';
import FrameToolbar from '../../src/components/video/toolbars/frame_toolbar/index.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';
import { ColorModeProvider } from '../../src/contexts/ColorMode.jsx';
import '../../src/index.css';
import '../../src/components/video/toolbars/editorToolbar.css';

vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ user: { _id: 'owner' } }) }));

async function mount({ fps = 24, theme = 'dark', width = 720, count = 2 } = {}) {
  await page.viewport(1280, 900);
  localStorage.setItem('colorMode', theme);
  let offset = 0;
  const layers = Array.from({ length: count }, (_, index) => {
    const duration = count === 2 ? (index === 0 ? 1 : 9) : 1;
    const layer = { _id: `scene-${index}`, duration, durationOffset: offset, imageSession: { activeItemList: [] } };
    offset += duration;
    return layer;
  });
  const view = render(<ColorModeProvider><StudioFrameRateContext.Provider value={fps}>
    <FrameToolbar layers={layers} audioLayers={[]} globalVideos={[]} globalAudioLayers={[]} sessionId="layout"
      framesPerSecond={fps} selectedLayerIndex={0} currentLayerSeek={0} frameToolbarView="EXPANDED"
      setSelectedLayerIndex={vi.fn()} setSelectedLayer={vi.fn()} setCurrentLayerSeek={vi.fn()} setIsLayerSeeking={vi.fn()} />
  </StudioFrameRateContext.Provider></ColorModeProvider>);
  const panel = view.container.querySelector('.toolbar-container');
  panel.style.width = `${width}px`;
  await waitFor(() => expect(view.container.querySelector('[data-scene-layer-body]').getBoundingClientRect().height).toBeGreaterThan(1));
  return { ...view, panel };
}

for (const fps of [16, 24, 30]) {
  it(`F2P: ${fps} FPS ruler, rows, and seek rail share rendered coordinates`, async () => {
    const { container } = await mount({ fps });
    await waitFor(() => {
      const rows = container.querySelectorAll('[data-scene-layer-body]');
      const first = rows[0].getBoundingClientRect();
      const second = rows[1].getBoundingClientRect();
      const tick = [...container.querySelectorAll('.time-ruler-tick')].find(el => el.textContent === '2s');
      const tickMark = tick.querySelector('.time-ruler-tick-mark').getBoundingClientRect();
      const expected = first.top + first.height + second.height / 9;
      expect(Math.abs(tickMark.top - expected)).toBeLessThanOrEqual(1.5);
    });
  });
}

it('F2P: 30 scene borders introduce no cumulative row drift', async () => {
  const { container } = await mount({ count: 30 });
  await waitFor(() => {
    const rows = container.querySelectorAll('[data-scene-layer-body]');
    const parent = container.querySelector('.layers-container').getBoundingClientRect();
    expect(Math.abs(rows[rows.length - 1].getBoundingClientRect().bottom - parent.bottom)).toBeLessThanOrEqual(1);
  });
});

for (const theme of ['light', 'dark']) {
  for (const width of [480, 720]) {
    it(`F2P: ${theme} expanded tabs stay reachable at ${width}px`, async () => {
      const { panel } = await mount({ theme, width });
      for (const name of ['Audio', 'Video', 'Global videos', 'Image', 'Text', 'Hints', 'Settings']) {
        const tab = screen.getByText(name, { exact: true });
        const bounds = tab.getBoundingClientRect();
        const shell = panel.getBoundingClientRect();
        expect(bounds.right).toBeLessThanOrEqual(shell.right);
        expect(bounds.left).toBeGreaterThanOrEqual(shell.left);
        fireEvent.click(tab);
      }
      expect(screen.getByText('Editor Options')).toBeVisible();
    });
  }
}

it('F2P: track handle dimensions match their ten-pixel slider compensation', async () => {
  const { panel } = await mount();
  const surface = document.createElement('div');
  surface.className = 'timeline-layer-range-surface';
  surface.innerHTML = '<div class="timeline-layer-trim-handle" style="height:10px"></div>';
  panel.appendChild(surface);
  expect(surface.firstElementChild.getBoundingClientRect().height).toBe(10);
});

it('F2P: relative positioning does not animate unrelated layout heights', async () => {
  const { container } = await mount();
  const relative = document.createElement('div');
  relative.className = 'relative';
  container.appendChild(relative);
  expect(getComputedStyle(relative).transitionProperty).not.toBe('height');
});
