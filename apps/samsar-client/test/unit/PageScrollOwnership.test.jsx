import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import OverflowContainer from '../../src/components/common/OverflowContainer.tsx';

const workspaceStyles = readFileSync('src/index.css', 'utf8');

vi.mock('../../src/components/common/TopNav.tsx', () => ({ default: () => <nav>Desktop navigation</nav> }));
vi.mock('../../src/components/common/MobileTopNav.tsx', () => ({ default: () => <nav>Mobile navigation</nav> }));
vi.mock('../../src/components/common/AlertDialog.tsx', () => ({ AlertDialog: () => null }));
vi.mock('../../src/utils/web.jsx', () => ({ getHeaders: () => null }));
vi.mock('../../src/utils/vidgenieRouting.js', () => ({ createBlankVidgenieSession: vi.fn() }));

let stylesheet;
beforeEach(() => {
  // Exercise the shared workspace CSS. Tailwind utilities and native scrolling
  // are covered by VidgenieScrolling.test.jsx in Chromium.
  stylesheet = document.createElement('style');
  stylesheet.textContent = workspaceStyles;
  document.head.appendChild(stylesheet);
});
afterEach(() => stylesheet.remove());

it('allows document scroll chaining through the content-sized page shell', () => {
  const { container } = render(
    <MemoryRouter><OverflowContainer><main>Long project content</main></OverflowContainer></MemoryRouter>
  );
  const shell = container.firstElementChild;
  expect(getComputedStyle(shell).getPropertyValue('overscroll-behavior')).not.toMatch(/contain|none/);
});

it('retains scroll containment for bounded workspace panels inside the page', () => {
  const { getByRole } = render(
    <MemoryRouter><OverflowContainer>
      <section aria-label="Settings" className="workspace-scroll" style={{ height: 160, overflowY: 'auto' }} />
    </OverflowContainer></MemoryRouter>
  );
  expect(getComputedStyle(getByRole('region', { name: 'Settings' })).getPropertyValue('overscroll-behavior')).toBe('contain');
});
