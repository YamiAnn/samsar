import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DropdownButton from '../../src/components/video/util/DropdownButton.jsx';
import AddText from '../../src/components/video/toolbars/text_toolbar/AddText.tsx';
import { AlertDialogProvider, useAlertDialog } from '../../src/contexts/AlertDialogContext.jsx';
import { ColorModeProvider } from '../../src/contexts/ColorMode.jsx';

vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ user: { _id: 'editor-user' } }) }));

describe('scene insertion menu', () => {
  const actions = () => ({ addLayerToComposition: vi.fn(), copyCurrentLayerBelow: vi.fn(), showBatchLayerDialog: vi.fn() });
  it.each([['Below current', 'below'], ['At end', 'end'], ['At beginning', 'beginning']])
    ('adds a scene %s, remembers the insertion position and closes', (name, value) => {
      const callbacks = actions();
      render(<DropdownButton {...callbacks} />);
      fireEvent.click(screen.getByRole('button', { name: 'Layer' }));
      expect(screen.getByRole('button', { name: 'Layer' })).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(screen.getByRole('menuitem', { name }));
      expect(callbacks.addLayerToComposition).toHaveBeenCalledExactlyOnceWith(value);
      expect(localStorage.getItem('defaultAddLayerSubOption')).toBe(value);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

  it.each([['Copy current', 'copyCurrentLayerBelow'], ['Add Batch', 'showBatchLayerDialog']])
    ('invokes %s exactly once without adding a blank scene', (name, callback) => {
      const callbacks = actions();
      render(<DropdownButton {...callbacks} compact iconOnly fullWidth fitMenuToTrigger menuAlign="left" />);
      fireEvent.click(screen.getByRole('button', { name: 'Layer' }));
      fireEvent.click(screen.getByRole('menuitem', { name }));
      expect(callbacks[callback]).toHaveBeenCalledOnce();
      expect(callbacks.addLayerToComposition).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

  it('closes on outside click but keeps clicks inside the menu open', () => {
    render(<DropdownButton {...actions()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Layer' }));
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('dismisses on Escape without running any action and ignores other keys', () => {
    const callbacks = actions();
    render(<DropdownButton {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: 'Layer' }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    Object.values(callbacks).forEach(callback => expect(callback).not.toHaveBeenCalled());
  });

  it('removes open-menu event handlers on unmount', () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<DropdownButton {...actions()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Layer' }));
    unmount();
    expect(removeListener).toHaveBeenCalledWith('mousedown', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('associates the trigger with its menu and supports a custom accessible label', () => {
    localStorage.setItem('defaultAddLayerSubOption', 'end');
    render(<DropdownButton {...actions()} buttonLabel="Scene" />);
    fireEvent.click(screen.getByRole('button', { name: 'Scene' }));
    expect(screen.getByRole('button', { name: 'Scene' })).toHaveAttribute('aria-controls', screen.getByRole('menu').id);
    expect(screen.getByRole('menu', { name: 'Scene actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'At end' })).toHaveClass('bg-sky-50');
  });
});

function TextForm({ submit, ...props }) {
  const [addText, setAddText] = useState('');
  const [textConfig, setTextConfig] = useState({});
  const dialog = useAlertDialog();
  return <>
    <AddText addText={addText} setAddText={setAddText} textConfig={textConfig}
      setTextConfig={setTextConfig} submitAddText={submit} {...props} />
    {dialog.isAlertDialogOpen && <section role="dialog">{dialog.alertDialogContent}</section>}
  </>;
}
function textForm(props = {}) {
  return render(<ColorModeProvider><AlertDialogProvider><TextForm submit={vi.fn()} {...props} /></AlertDialogProvider></ColorModeProvider>);
}

describe('adding canvas text', () => {
  it('disables Add until the user enters non-whitespace text', () => {
    textForm();
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Enter text'), { target: { value: ' \n ' } });
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Enter text'), { target: { value: 'Caption' } });
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  });

  it('submits trimmed text with the normalized canvas style and preserves internal line breaks', () => {
    const submit = vi.fn();
    textForm({ submit });
    fireEvent.change(screen.getByPlaceholderText('Enter text'), { target: { value: '  Hello\nworld  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({ text: 'Hello\nworld',
      config: expect.objectContaining({ fontFamily: 'Arial', fontSize: 32, autoWrap: true }) });
    expect(localStorage.getItem('selected_text_config_addText')).toBe('  Hello\nworld  ');
  });

  it('restores saved text and shared preferences across remounts', () => {
    localStorage.setItem('selected_text_config_addText', 'Saved caption');
    localStorage.setItem('selected_text_config_fontSize', '72');
    localStorage.setItem('selected_text_config_bold', 'true');
    const submit = vi.fn();
    textForm({ submit });
    expect(screen.getByPlaceholderText('Enter text')).toHaveValue('Saved caption');
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    expect(submit).toHaveBeenCalledWith({ text: 'Saved caption', config: expect.objectContaining({ fontSize: 72, bold: true }) });
  });

  it('opens real text options and submits the current caption through the dialog', () => {
    const submit = vi.fn();
    textForm({ submit });
    fireEvent.change(screen.getByPlaceholderText('Enter text'), { target: { value: 'Night sky' } });
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Text options');
    const buttons = screen.getAllByRole('button', { name: 'Add', exact: true });
    fireEvent.click(buttons[1]);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ text: 'Night sky' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the full style controls in expanded view with no Options shortcut', () => {
    textForm({ isExpandedView: true, editorVariant: 'imageStudio' });
    expect(screen.queryByRole('button', { name: 'Options' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Enter text'), { target: { value: 'Expanded caption' } });
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  });
});
