import { createContext, useContext } from 'react';

// Legacy standalone consumers retain their display clock until a session is bound.
export const StudioFrameRateContext = createContext(30);
export function resolveStudioFramesPerSecond(value) {
  const rate = Number(value);
  return [16, 24, 30].includes(rate) ? rate : 24;
}
export function useStudioFrameRate() {
  return useContext(StudioFrameRateContext);
}
