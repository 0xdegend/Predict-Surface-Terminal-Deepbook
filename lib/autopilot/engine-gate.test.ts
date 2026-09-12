import { describe, it, expect } from 'vitest';
import { engineShouldRun } from './engine-gate';

const gate = (status: Parameters<typeof engineShouldRun>[0]['status'], openCount = 0, wanted = 0) =>
  engineShouldRun({ status, openCount, wanted });

describe('engineShouldRun', () => {
  it('drives a live run wherever the trader is, with nothing asking for it', () => {
    // The whole point of moving the engine above the page: leaving Autopilot for the
    // Trade page used to clear the loop's interval and the run stopped placing trades.
    expect(gate('armed')).toBe(true);
    expect(gate('paused')).toBe(true);
  });

  it('keeps driving a stopped run while trades are still tracked, so they get scored', () => {
    expect(gate('stopped', 1)).toBe(true);
    expect(gate('stopped', 0)).toBe(false);
  });

  it('stays off for a trader who has never armed anything', () => {
    expect(gate('idle')).toBe(false);
  });

  it('drives on request, which is the panel showing its live read before a run is armed', () => {
    expect(gate('idle', 0, 1)).toBe(true);
    expect(gate('stopped', 0, 1)).toBe(true);
  });

  it('stops once the last asker unmounts', () => {
    expect(gate('idle', 0, 0)).toBe(false);
  });
});
