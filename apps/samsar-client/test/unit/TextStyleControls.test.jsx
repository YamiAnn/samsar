import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TextStylePanel, { buildTextStyleDraft } from '../../src/components/common/TextStylePanel.jsx';

vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ user: { _id: 'editor-user' } }) }));

function ControlledStyle({ initial, ...props }) {
  const [value, onChange] = useState(() => buildTextStyleDraft(initial));
  return <><TextStylePanel value={value} onChange={onChange} {...props} />
    <output data-testid="style-value">{JSON.stringify(value)}</output></>;
}
const value = () => JSON.parse(screen.getByTestId('style-value').textContent);
const numberField = label => screen.getByText(label, { exact: true }).parentElement.querySelector('input');

describe('text style controls', () => {
  it.each([['Bold', 'bold'], ['Italic', 'italic'], ['Underline', 'underline']])
    ('toggles %s without losing the current caption', (title, field) => {
      render(<ControlledStyle initial={{ text: 'Caption' }} />);
      fireEvent.click(screen.getByTitle(title));
      expect(value()).toMatchObject({ text: 'Caption', [field]: true });
      fireEvent.click(screen.getByTitle(title));
      expect(value()[field]).toBe(false);
    });

  it.each(['left', 'center', 'right'])('applies %s alignment to the real preview', textAlign => {
    render(<ControlledStyle initial={{ text: 'Alignment sample' }} />);
    fireEvent.click(screen.getByTitle(`Align ${textAlign}`));
    expect(value().textAlign).toBe(textAlign);
    expect(screen.getByText('Alignment sample', { selector: 'div' })).toHaveStyle({ textAlign });
  });

  it.each([
    ['Size', '500', 'fontSize', 240], ['Size', '', 'fontSize', 32],
    ['Line Height', '2.3', 'lineHeight', 2.3], ['Line Height', '-1', 'lineHeight', 0.6],
    ['Box Width', '9000', 'width', 4096], ['Box Height', '1', 'height', 24],
    ['Letter Space', '1.5', 'letterSpacing', 1.5], ['Rotation', '-999', 'rotationAngle', -360],
    ['Shadow Blur', '-1', 'shadowBlur', 0], ['Shadow X', '-250', 'shadowOffsetX', -200],
    ['Shadow Y', '250', 'shadowOffsetY', 200],
  ])('normalizes %s input %s before updating the canvas draft', (label, input, key, expected) => {
    render(<ControlledStyle advancedInitiallyOpen />);
    fireEvent.change(numberField(label), { target: { value: input } });
    expect(value()[key]).toBe(expected);
  });

  it('automatically enables an outline when its color is selected', () => {
    const { container } = render(<ControlledStyle initial={{ strokeWidth: 0 }} />);
    fireEvent.change(container.querySelectorAll('input[type="color"]')[1], { target: { value: '#123456' } });
    expect(value()).toMatchObject({ strokeColor: '#123456', strokeWidth: 1 });
    expect(screen.getByText('#123456', { exact: true })).toBeInTheDocument();
  });

  it('keeps an existing outline thickness when its color changes', () => {
    const { container } = render(<ControlledStyle initial={{ strokeWidth: 5 }} />);
    fireEvent.change(container.querySelectorAll('input[type="color"]')[1], { target: { value: '#654321' } });
    expect(value()).toMatchObject({ strokeColor: '#654321', strokeWidth: 5 });
  });

  it('updates fill color and preserves the other canvas settings', () => {
    const { container } = render(<ControlledStyle initial={{ fontSize: 60, bold: true }} />);
    fireEvent.change(container.querySelector('input[type="color"]'), { target: { value: '#112233' } });
    expect(value()).toMatchObject({ fillColor: '#112233', bold: true, fontSize: 60 });
  });

  it('switches between wrapped and literal multiline rendering', () => {
    render(<ControlledStyle initial={{ text: 'A long line' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Word Wrap On' }));
    expect(value().autoWrap).toBe(false);
    expect(screen.getByText('A long line', { selector: 'div' })).toHaveStyle({ whiteSpace: 'pre', overflowX: 'auto' });
    fireEvent.click(screen.getByRole('button', { name: 'Word Wrap Off' }));
    expect(value().autoWrap).toBe(true);
  });

  it('toggles uppercase preview while preserving the actual text content', () => {
    render(<ControlledStyle initial={{ text: 'Mixed case' }} advancedInitiallyOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Caps Off' }));
    expect(value()).toMatchObject({ text: 'Mixed case', capitalizeLetters: true });
    expect(screen.getByText('Mixed case', { selector: 'div' })).toHaveStyle({ textTransform: 'uppercase' });
  });

  it('invokes each layer action independently', () => {
    const backward = vi.fn(), forward = vi.fn(), remove = vi.fn();
    render(<ControlledStyle layerActions={[
      { label: 'Move backward', icon: 'backward', onClick: backward },
      { label: 'Move forward', icon: 'forward', onClick: forward },
      { label: 'Delete', icon: 'delete', intent: 'danger', onClick: remove },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move backward' }));
    expect(backward).toHaveBeenCalledOnce(); expect(forward).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move forward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(forward).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
  });

  it('omits preview and submit button when used as compact style controls only', () => {
    render(<ControlledStyle density="compact" showSubmitButton={false} />);
    expect(screen.queryByText('Preview', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add text' })).not.toBeInTheDocument();
  });

  it('runs the supplied submit action and respects explicit disabled state', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<ControlledStyle onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    rerender(<ControlledStyle onSubmit={onSubmit} submitDisabled />);
    expect(screen.getByRole('button', { name: 'Add text' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
