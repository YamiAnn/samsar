import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import DropdownButton from '../../src/components/video/util/DropdownButton.jsx';
import CommonDropdownButton from '../../src/components/common/CommonDropdownButton.tsx';
vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ user: { _id: 'owner' } }) }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });

it('F2P: the scene menu escapes deeply nested scrolling panel headers', () => {
  const add = vi.fn();
  render(<div data-scroll-panel style={{ overflow: 'auto', height: 40 }}><DropdownButton
    addLayerToComposition={add} copyCurrentLayerBelow={vi.fn()} showBatchLayerDialog={vi.fn()} /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Layer' }));
  expect(screen.getByRole('menu').closest('[data-scroll-panel]')).toBeNull();
  fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'At end' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'At end' }));
  expect(add).toHaveBeenCalledExactlyOnceWith('end');
});

it('F2P: shared action menus escape deeply nested scrolling panel headers', () => {
  render(<div data-scroll-panel style={{ overflow: 'auto', height: 40 }}><CommonDropdownButton mainLabel="Actions"
    onMainClick={vi.fn()} dropdownItems={[{ label: 'Refresh', onClick: vi.fn() }]} /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Actions options' }));
  expect(screen.getByRole('menu').closest('[data-scroll-panel]')).toBeNull();
});
