import { describe, expect, it } from 'vitest';
import { computeDeadlines } from './sla-deadlines.js';

const createdAt = new Date('2026-11-01T12:00:00.000Z');
const urgent = { firstResponseMinutes: 60, resolutionMinutes: 240 };

describe('computeDeadlines', () => {
  it('soma os minutos da política à abertura', () => {
    expect(computeDeadlines(createdAt, urgent)).toEqual({
      firstResponseDueAt: new Date('2026-11-01T13:00:00.000Z'),
      resolutionDueAt: new Date('2026-11-01T16:00:00.000Z'),
    });
  });

  it('empurra os dois prazos pelo tempo pausado', () => {
    expect(computeDeadlines(createdAt, urgent, 30 * 60)).toEqual({
      firstResponseDueAt: new Date('2026-11-01T13:30:00.000Z'),
      resolutionDueAt: new Date('2026-11-01T16:30:00.000Z'),
    });
  });
});
