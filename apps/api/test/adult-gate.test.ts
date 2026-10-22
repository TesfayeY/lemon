import { describe, it, expect } from 'vitest';
import { parseBirthDate, calculateAge, isAdultEligible, adultBoundaryDate } from '../src/modules/auth/adult-gate.js';

describe('parseBirthDate', () => {
  it('accepts a valid date', () => {
    const result = parseBirthDate('1990-06-15');
    expect(result.valid).toBe(true);
  });

  it('rejects non-ISO format', () => {
    const result = parseBirthDate('06/15/1990');
    expect(result.valid).toBe(false);
  });

  it('rejects future dates', () => {
    const result = parseBirthDate('2099-01-01');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('future');
  });

  it('rejects impossible calendar date (Feb 30)', () => {
    const result = parseBirthDate('1990-02-30');
    expect(result.valid).toBe(false);
  });

  it('accepts Feb 29 on a leap year', () => {
    const result = parseBirthDate('2000-02-29');
    expect(result.valid).toBe(true);
  });

  it('rejects Feb 29 on a non-leap year', () => {
    const result = parseBirthDate('2001-02-29');
    expect(result.valid).toBe(false);
  });

  it('rejects month 13', () => {
    const result = parseBirthDate('1990-13-01');
    expect(result.valid).toBe(false);
  });

  it('rejects day 0', () => {
    const result = parseBirthDate('1990-01-00');
    expect(result.valid).toBe(false);
  });

  it('rejects absurdly old year', () => {
    const result = parseBirthDate('1800-01-01');
    expect(result.valid).toBe(false);
  });
});

describe('calculateAge', () => {
  it('calculates age correctly for a past birthday this year', () => {
    // If someone was born Jan 1, 2000 and it's Dec 1, 2026
    const birth = new Date(Date.UTC(2000, 0, 1));
    const asOf = new Date(Date.UTC(2026, 11, 1));
    expect(calculateAge(birth, asOf)).toBe(26);
  });

  it('calculates age correctly when birthday has not occurred yet', () => {
    // Born Dec 31, 2000 and it's Jan 1, 2026
    const birth = new Date(Date.UTC(2000, 11, 31));
    const asOf = new Date(Date.UTC(2026, 0, 1));
    expect(calculateAge(birth, asOf)).toBe(25);
  });

  it('calculates age on exact birthday', () => {
    const birth = new Date(Date.UTC(2000, 5, 15));
    const asOf = new Date(Date.UTC(2026, 5, 15));
    expect(calculateAge(birth, asOf)).toBe(26);
  });

  it('handles Feb 29 birthday in a non-leap year (before Mar 1)', () => {
    // Born Feb 29 2000, checking on Feb 28 2025 (non-leap)
    const birth = new Date(Date.UTC(2000, 1, 29));
    const asOf = new Date(Date.UTC(2025, 1, 28));
    expect(calculateAge(birth, asOf)).toBe(24);
  });

  it('handles Feb 29 birthday on Mar 1 of non-leap year', () => {
    // Born Feb 29 2000, checking on Mar 1 2025 (non-leap)
    const birth = new Date(Date.UTC(2000, 1, 29));
    const asOf = new Date(Date.UTC(2025, 2, 1));
    expect(calculateAge(birth, asOf)).toBe(25);
  });
});

describe('isAdultEligible', () => {
  it('returns true for someone 18+', () => {
    const birth = new Date(Date.UTC(2000, 0, 1));
    const asOf = new Date(Date.UTC(2026, 0, 1));
    expect(isAdultEligible(birth, asOf)).toBe(true);
  });

  it('returns false for someone under 18', () => {
    const birth = new Date(Date.UTC(2010, 0, 1));
    const asOf = new Date(Date.UTC(2026, 0, 1));
    expect(isAdultEligible(birth, asOf)).toBe(false);
  });

  it('returns true on the exact 18th birthday', () => {
    const asOf = new Date(Date.UTC(2026, 5, 15));
    const birth = new Date(Date.UTC(2008, 5, 15));
    expect(isAdultEligible(birth, asOf)).toBe(true);
  });

  it('returns false one day before 18th birthday', () => {
    const asOf = new Date(Date.UTC(2026, 5, 14));
    const birth = new Date(Date.UTC(2008, 5, 15));
    expect(isAdultEligible(birth, asOf)).toBe(false);
  });

  it('handles leap day boundary: born Feb 29, turns 18 on Mar 1 in non-leap year', () => {
    // Born Feb 29, 2008 (leap year)
    // 2026 is not a leap year
    // On Feb 28, 2026: still 17
    const birth = new Date(Date.UTC(2008, 1, 29));
    expect(isAdultEligible(birth, new Date(Date.UTC(2026, 1, 28)))).toBe(false);
    // On Mar 1, 2026: 18
    expect(isAdultEligible(birth, new Date(Date.UTC(2026, 2, 1)))).toBe(true);
  });
});

describe('adultBoundaryDate', () => {
  it('returns a date exactly 18 years before the given date', () => {
    const asOf = new Date(Date.UTC(2026, 5, 15));
    const boundary = adultBoundaryDate(asOf);
    expect(boundary.getUTCFullYear()).toBe(2008);
    expect(boundary.getUTCMonth()).toBe(5);
    expect(boundary.getUTCDate()).toBe(15);
  });
});
