import { render, screen, waitFor } from '@testing-library/react';
import { page, userEvent } from 'vitest/browser';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import OneshotEditorContainer from '../../src/components/oneshot_editor/OneshotEditorContainer.jsx';
import '../../src/index.css';
import '../../src/components/oneshot_editor/mobileStyles.css';

vi.mock('../../src/contexts/UserContext.jsx', () => ({
  useUser: () => ({ user: { _id: 'owner' }, userFetching: false, userInitiated: true }),
}));
vi.mock('../../src/contexts/ColorMode.jsx', () => ({
  useColorMode: () => ({ colorMode: document.body.classList.contains('theme-dark') ? 'dark' : 'light' }),
}));
vi.mock('../../src/components/common/TopNav.tsx', () => ({ default: () => <nav>Desktop navigation</nav> }));
vi.mock('../../src/components/common/MobileTopNav.tsx', () => ({ default: () => <nav>Mobile navigation</nav> }));
vi.mock('../../src/components/common/AlertDialog.tsx', () => ({ AlertDialog: () => null }));
// Keep the actual route and shared page shell. Generation requests are unrelated
// to native scrolling, so substitute only the editor's content.
vi.mock('../../src/components/oneshot_editor/OneshotEditor.jsx', () => ({
  default: () => (
    <section className="vidgenie-editor-shell" aria-label="Vidgenie editor">
      <div data-testid="page-scroll-target" style={{ height: 220 }}>Project settings</div>
      <div className="workspace-scroll overflow-y-auto" data-testid="bounded-panel" style={{ height: 160 }}>
        <div style={{ height: 1200 }}>Scrollable settings panel</div>
      </div>
      <div style={{ height: 1800 }}>Project content</div>
      <button type="button">Generate video</button>
    </section>
  ),
}));

afterEach(() => {
  document.body.classList.remove('theme-dark', 'theme-light');
  window.scrollTo(0, 0);
});

async function mount(width, theme) {
  await page.viewport(width, 640);
  document.body.classList.add(`theme-${theme}`);
  render(
    <MemoryRouter initialEntries={['/vidgenie/scroll-project']}>
      <Routes>
        <Route path="/vidgenie/:id" element={<OneshotEditorContainer />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByRole('region', { name: 'Vidgenie editor' });
  expect(document.scrollingElement.scrollHeight).toBeGreaterThan(window.innerHeight);
}

for (const width of [390, 1280]) {
  for (const theme of ['light', 'dark']) {
    it(`scrolls the ${theme} Vidgenie document with native wheel input at ${width}px`, async () => {
      await mount(width, theme);
      await userEvent.wheel(screen.getByTestId('page-scroll-target'), { delta: { y: 600 } });
      await waitFor(() => expect(window.scrollY).toBeGreaterThan(0));

      // Content below the fold remains reachable through normal document scrolling.
      const generateButton = screen.getByRole('button', { name: 'Generate video' });
      for (let index = 0; index < 4 && document.activeElement !== generateButton; index += 1) {
        await userEvent.tab();
      }
      await expect.element(page.getByRole('button', { name: 'Generate video' })).toHaveFocus();
      const button = screen.getByRole('button', { name: 'Generate video' }).getBoundingClientRect();
      expect(button.top).toBeGreaterThanOrEqual(0);
      expect(button.bottom).toBeLessThanOrEqual(window.innerHeight);
    });
  }
}

it('keeps native scrolling contained inside bounded workspace panels', async () => {
  await mount(1280, 'dark');
  const panel = screen.getByTestId('bounded-panel');
  expect(getComputedStyle(panel).overscrollBehaviorY).toBe('contain');
  await userEvent.wheel(panel, { delta: { y: 200 } });
  await waitFor(() => expect(panel.scrollTop).toBeGreaterThan(0));
  expect(window.scrollY).toBe(0);

  panel.scrollTop = panel.scrollHeight;
  await userEvent.wheel(panel, { delta: { y: 400 } });
  expect(window.scrollY).toBe(0);
});
