import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useUndoRedoState from '../../src/hooks/useUndoRedoState.js';

describe('history updates across batched editor actions', () => {
  it('applies synchronous functional edits to the latest state without losing intermediate undo entries', () => {
    const { result } = renderHook(() => useUndoRedoState([{ value: 0 }]));
    let first;
    let second;
    act(() => {
      first = result.current.setState((items) => [{ value: items[0].value + 1 }]);
      second = result.current.setState((items) => [{ value: items[0].value + 1 }]);
    });
    expect(first).toEqual([{ value: 1 }]);
    expect(second).toEqual([{ value: 2 }]);
    expect(result.current.state).toEqual([{ value: 2 }]);
    expect(result.current.undoCount).toBe(2);
    act(() => { result.current.undo(); result.current.undo(); });
    expect(result.current.state).toEqual([{ value: 0 }]);
    expect(result.current.redoCount).toBe(2);
    act(() => { result.current.redo(); result.current.redo(); });
    expect(result.current.state).toEqual([{ value: 2 }]);
  });

  it('clears old history on an explicit scene reset even when the arriving scene has identical content', () => {
    const { result } = renderHook(() => useUndoRedoState(['original']));
    act(() => result.current.setState(['edited']));
    act(() => result.current.setState(['later']));
    act(() => result.current.undo());
    expect(result.current).toMatchObject({ undoCount: 1, redoCount: 1 });
    act(() => result.current.syncState(['edited'], { resetHistory: true }));
    expect(result.current).toMatchObject({ state: ['edited'], canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
  });

  it('keeps redo available after a duplicate server refresh and resolves sync updaters against a cloned current state', () => {
    const { result } = renderHook(() => useUndoRedoState([{ style: { fill: 'red' } }]));
    act(() => result.current.setState([{ style: { fill: 'blue' } }]));
    act(() => result.current.undo());
    act(() => result.current.syncState([{ style: { fill: 'red' } }]));
    expect(result.current.redoCount).toBe(1);
    act(() => result.current.syncState((items) => {
      items[0].style.fill = 'green';
      return items;
    }));
    expect(result.current.state[0].style.fill).toBe('green');
    expect(result.current.redoCount).toBe(1);
    act(() => result.current.redo());
    expect(result.current.state[0].style.fill).toBe('blue');
    act(() => result.current.undo());
    expect(result.current.state[0].style.fill).toBe('green');
  });

  it.each([
    [0, 1], [-4, 1], [2.9, 2], [Infinity, 5], [NaN, 5], ['2', 5],
  ])('retains a usable bounded history for limit %s', (limit, retained) => {
    const { result } = renderHook(() => useUndoRedoState([0], { limit }));
    act(() => {
      for (let value = 1; value <= 8; value += 1) result.current.setState([value]);
    });
    expect(result.current.undoCount).toBe(retained);
    act(() => {
      for (let count = 0; count <= retained; count += 1) result.current.undo();
    });
    expect(result.current.state).toEqual([8 - retained]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.redoCount).toBe(retained);
  });

  it('normalizes malformed initial and update values to an empty item list', () => {
    const { result } = renderHook(() => useUndoRedoState({ invalid: true }));
    expect(result.current.state).toEqual([]);
    act(() => result.current.setState(['item']));
    act(() => result.current.setState(null));
    expect(result.current.state).toEqual([]);
    act(() => result.current.undo());
    expect(result.current.state).toEqual(['item']);
  });

  it('protects history from caller mutation on browsers without structuredClone', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true, value: undefined });
    try {
      const initial = [{ style: { fill: 'red' } }];
      const { result } = renderHook(() => useUndoRedoState(initial));
      initial[0].style.fill = 'changed outside editor';
      act(() => result.current.setState([{ style: { fill: 'blue' } }]));
      act(() => result.current.undo());
      expect(result.current.state[0].style.fill).toBe('red');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'structuredClone', descriptor);
      else delete globalThis.structuredClone;
    }
  });
});
