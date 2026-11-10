import { describe, expect, it, vi } from 'vitest';
import {
  locationsCompatible,
  resolveResidence,
  scopeIncludes,
  viewerScopeFilter,
  type DiscoveryCity,
  type LocationCatalog,
  type Residence,
} from '../src/modules/discovery/location.js';
import { browseBlocker, pairBlocker, type DiscoveryParticipant } from '../src/modules/discovery/eligibility.js';
import { seededRandom, stableShuffle } from '../src/modules/discovery/shuffle.js';
import { decodeCursor, encodeCursor, resolveCursorSecret } from '../src/modules/discovery/cursor.js';
import { combineExclusions, noPairExclusions } from '../src/modules/discovery/exclusions.js';

/**
 * Fictional catalog: P-07 (launch metros) is open, so no real city is
 * presented as an approved market. States XA/XB are invented.
 */
const CITIES: DiscoveryCity[] = [
  { id: 'springfield-xa', stateCode: 'XA', countryCode: 'US', metroId: 'metro-lakes' },
  { id: 'springfield-xb', stateCode: 'XB', countryCode: 'US' },
  { id: 'riverton-xa', stateCode: 'XA', countryCode: 'US' },
  { id: 'lakeview-xa', stateCode: 'XA', countryCode: 'US', metroId: 'metro-lakes' },
  { id: 'harbor-xb', stateCode: 'XB', countryCode: 'US', metroId: 'metro-lakes' },
  { id: 'abroad-city', stateCode: 'ZZ', countryCode: 'ET' },
];
const fictionalCatalog: LocationCatalog = {
  findCity: (id) => CITIES.find((c) => c.id === id),
  metroCityIds: (metroId) => CITIES.filter((c) => c.metroId === metroId).map((c) => c.id),
};

const NOW = new Date('2026-11-10T12:00:00Z');
const ctx = { now: NOW, catalog: fictionalCatalog };

function person(userId: string, overrides: Partial<DiscoveryParticipant> = {}): DiscoveryParticipant {
  return {
    userId,
    accountStatus: 'active',
    profileReady: true,
    discoverPaused: false,
    birthDate: '1996-05-01', // 30 on NOW
    genderIdentity: 'woman',
    cityId: 'riverton-xa',
    stateCode: 'XA',
    countryCode: 'US',
    preferences: {
      acceptedGenderCategories: ['man'],
      minAge: 25,
      maxAge: 40,
      locationScope: 'state',
      longDistance: false,
    },
    ...overrides,
  };
}

const man = (userId: string, overrides: Partial<DiscoveryParticipant> = {}) =>
  person(userId, {
    genderIdentity: 'man',
    birthDate: '1994-02-15', // 32 on NOW
    preferences: { acceptedGenderCategories: ['woman'], minAge: 25, maxAge: 40, locationScope: 'state', longDistance: false },
    ...overrides,
  });

const withPrefs = (p: DiscoveryParticipant, prefs: Partial<NonNullable<DiscoveryParticipant['preferences']>>) =>
  ({ ...p, preferences: { ...p.preferences!, ...prefs } });

const res = (cityId: string): Residence => resolveResidence({ cityId, stateCode: fictionalCatalog.findCity(cityId)!.stateCode, countryCode: 'US' }, fictionalCatalog)!;

describe('resolveResidence', () => {
  it('resolves a catalog city with its state and explicit metro', () => {
    expect(resolveResidence({ cityId: 'lakeview-xa', stateCode: 'XA', countryCode: 'US' }, fictionalCatalog))
      .toEqual({ cityId: 'lakeview-xa', stateCode: 'XA', metroId: 'metro-lakes' });
    expect(res('riverton-xa').metroId).toBeNull();
  });

  it('rejects stale city IDs that are no longer in the catalog', () => {
    expect(resolveResidence({ cityId: 'city-removed-xa', stateCode: 'XA', countryCode: 'US' }, fictionalCatalog)).toBeNull();
  });

  it('keeps non-US residence out of the launch pool', () => {
    expect(resolveResidence({ cityId: 'abroad-city', stateCode: 'ZZ', countryCode: 'US' }, fictionalCatalog)).toBeNull();
    expect(resolveResidence({ cityId: 'riverton-xa', stateCode: 'XA', countryCode: 'ET' }, fictionalCatalog)).toBeNull();
  });

  it('fails closed when the stored state disagrees with the catalog', () => {
    expect(resolveResidence({ cityId: 'riverton-xa', stateCode: 'XB', countryCode: 'US' }, fictionalCatalog)).toBeNull();
  });

  it('requires a city', () => {
    expect(resolveResidence({ cityId: null, stateCode: 'XA', countryCode: 'US' }, fictionalCatalog)).toBeNull();
  });

  it('ignores hometown: only current residence fields are read', () => {
    const withHometown = { cityId: null, stateCode: null, countryCode: 'US', hometown: 'springfield-xa' };
    expect(resolveResidence(withHometown, fictionalCatalog)).toBeNull();
  });
});

describe('scopeIncludes and the mutual location rule', () => {
  it('treats same-name cities in different states as different places', () => {
    expect(scopeIncludes('city', res('springfield-xa'), res('springfield-xb'))).toBe(false);
    expect(scopeIncludes('state', res('springfield-xa'), res('springfield-xb'))).toBe(false);
  });

  it('city scope matches the same city or an explicit metro sibling, even across states', () => {
    expect(scopeIncludes('city', res('riverton-xa'), res('riverton-xa'))).toBe(true);
    expect(scopeIncludes('city', res('springfield-xa'), res('lakeview-xa'))).toBe(true);
    expect(scopeIncludes('city', res('springfield-xa'), res('harbor-xb'))).toBe(true);
    // Same state but no shared metro: no inferred mileage
    expect(scopeIncludes('city', res('riverton-xa'), res('lakeview-xa'))).toBe(false);
  });

  it('state scope matches the same state; nationwide matches any US residence', () => {
    expect(scopeIncludes('state', res('riverton-xa'), res('lakeview-xa'))).toBe(true);
    expect(scopeIncludes('state', res('riverton-xa'), res('harbor-xb'))).toBe(false);
    expect(scopeIncludes('nationwide', res('riverton-xa'), res('harbor-xb'))).toBe(true);
  });

  it('unknown scopes fail closed', () => {
    expect(scopeIncludes('galaxy' as never, res('riverton-xa'), res('riverton-xa'))).toBe(false);
  });

  it('is mutual: a nationwide viewer is not shown to a person whose state scope excludes them', () => {
    const a = { residence: res('riverton-xa'), scope: 'nationwide' as const };
    const b = { residence: res('harbor-xb'), scope: 'state' as const };
    expect(locationsCompatible(a, b)).toBe(false);
    expect(locationsCompatible(b, a)).toBe(false);
    expect(locationsCompatible(a, { ...b, scope: 'nationwide' })).toBe(true);
  });

  it('builds the viewer-side index pre-filter', () => {
    expect(viewerScopeFilter('city', res('riverton-xa'), ['riverton-xa'])).toEqual({ cityId: 'riverton-xa' });
    expect(viewerScopeFilter('city', res('springfield-xa'), ['springfield-xa', 'lakeview-xa']))
      .toEqual({ cityId: { $in: ['springfield-xa', 'lakeview-xa'] } });
    expect(viewerScopeFilter('state', res('riverton-xa'), [])).toEqual({ stateCode: 'XA' });
    expect(viewerScopeFilter('nationwide', res('riverton-xa'), [])).toEqual({});
  });
});

describe('browseBlocker', () => {
  it('allows an active, ready, unpaused viewer with preferences and US residence', () => {
    expect(browseBlocker(person('v'), ctx)).toBeNull();
  });

  it.each([
    ['onboarding', { accountStatus: 'onboarding' }, 'account_inactive'],
    ['suspended', { accountStatus: 'suspended' }, 'account_inactive'],
    ['deletion pending', { accountStatus: 'deletion_pending' }, 'account_inactive'],
    ['incomplete profile', { profileReady: false }, 'profile_not_ready'],
    ['paused', { discoverPaused: true }, 'paused'],
    ['no preferences', { preferences: null }, 'missing_preferences'],
    ['no gender identity', { genderIdentity: null }, 'missing_preferences'],
    ['no birth date', { birthDate: null }, 'missing_birth_date'],
    ['stale city', { cityId: 'gone-xa' }, 'invalid_residence'],
    ['non-US city', { cityId: 'abroad-city', stateCode: 'ZZ' }, 'invalid_residence'],
  ] as const)('blocks a viewer who is %s', (_label, overrides, reason) => {
    expect(browseBlocker(person('v', overrides as Partial<DiscoveryParticipant>), ctx)).toBe(reason);
  });

  it('blocks a viewer with no accepted gender categories', () => {
    expect(browseBlocker(withPrefs(person('v'), { acceptedGenderCategories: [] }), ctx)).toBe('missing_preferences');
  });
});

describe('pairBlocker', () => {
  const viewer = person('viewer');

  it('accepts a mutually eligible pair', () => {
    expect(pairBlocker(viewer, man('c'), ctx)).toBeNull();
  });

  it('never matches someone with themselves', () => {
    expect(pairBlocker(viewer, { ...viewer }, ctx)).toBe('self');
  });

  it.each([
    ['inactive', { accountStatus: 'suspended' }, 'account_inactive'],
    ['onboarding', { accountStatus: 'onboarding' }, 'account_inactive'],
    ['incomplete', { profileReady: false }, 'profile_not_ready'],
    ['paused', { discoverPaused: true }, 'paused'],
    ['without preferences', { preferences: null }, 'missing_preferences'],
    ['living abroad', { cityId: 'abroad-city', stateCode: 'ZZ' }, 'invalid_residence'],
    ['on a stale city ID', { cityId: 'old-id-xa' }, 'invalid_residence'],
  ] as const)('excludes a candidate who is %s', (_label, overrides, reason) => {
    expect(pairBlocker(viewer, man('c', overrides as Partial<DiscoveryParticipant>), ctx)).toBe(reason);
  });

  it('requires both gender/interest choices to include the other', () => {
    // Viewer wants men; candidate is a man who only wants men
    const oneWay = withPrefs(man('c'), { acceptedGenderCategories: ['man'] });
    expect(pairBlocker(viewer, oneWay, ctx)).toBe('gender_mismatch');
    expect(pairBlocker(oneWay, viewer, ctx)).toBe('gender_mismatch');
    // Candidate wants women, but viewer does not want nonbinary people
    expect(pairBlocker(viewer, man('c', { genderIdentity: 'nonbinary' }), ctx)).toBe('gender_mismatch');
  });

  it('requires both age ranges to include the other, inclusively', () => {
    expect(pairBlocker(withPrefs(viewer, { maxAge: 32 }), man('c'), ctx)).toBeNull();
    expect(pairBlocker(withPrefs(viewer, { maxAge: 31 }), man('c'), ctx)).toBe('age_mismatch');
    // The candidate's range excludes the 30-year-old viewer
    expect(pairBlocker(viewer, withPrefs(man('c'), { minAge: 31 }), ctx)).toBe('age_mismatch');
    expect(pairBlocker(viewer, withPrefs(man('c'), { maxAge: 29 }), ctx)).toBe('age_mismatch');
  });

  it('computes age from the injected clock (birthday boundary)', () => {
    const turns33Tomorrow = man('c', { birthDate: '1993-11-11' });
    const turns33Today = man('c', { birthDate: '1993-11-10' });
    const strict = withPrefs(viewer, { maxAge: 32 });
    expect(pairBlocker(strict, turns33Tomorrow, ctx)).toBeNull();
    expect(pairBlocker(strict, turns33Today, ctx)).toBe('age_mismatch');
    expect(pairBlocker(strict, turns33Tomorrow, { ...ctx, now: new Date('2026-11-11T00:00:00Z') })).toBe('age_mismatch');
  });

  it('requires both location scopes to include the other', () => {
    const elsewhere = man('c', { cityId: 'harbor-xb', stateCode: 'XB' });
    expect(pairBlocker(viewer, elsewhere, ctx)).toBe('location_mismatch');
    // Viewer goes nationwide, but the candidate's state scope still excludes XA
    expect(pairBlocker(withPrefs(viewer, { locationScope: 'nationwide' }), elsewhere, ctx)).toBe('location_mismatch');
    const bothNationwide = withPrefs(elsewhere, { locationScope: 'nationwide' });
    expect(pairBlocker(withPrefs(viewer, { locationScope: 'nationwide' }), bothNationwide, ctx)).toBeNull();
  });

  it('never lets longDistance override a hard location scope', () => {
    const elsewhere = withPrefs(man('c', { cityId: 'harbor-xb', stateCode: 'XB' }), { longDistance: true });
    expect(pairBlocker(withPrefs(viewer, { longDistance: true }), elsewhere, ctx)).toBe('location_mismatch');
  });

  it('keeps same-name cities in different states apart under city scope', () => {
    const a = withPrefs(person('a', { cityId: 'springfield-xa', stateCode: 'XA' }), { locationScope: 'city' });
    const b = withPrefs(man('b', { cityId: 'springfield-xb', stateCode: 'XB' }), { locationScope: 'city' });
    expect(pairBlocker(a, b, ctx)).toBe('location_mismatch');
  });
});

describe('stableShuffle', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `u${String(i).padStart(2, '0')}`);

  it('is a deterministic permutation for a given seed and leaves the input untouched', () => {
    const copy = [...ids];
    const a = stableShuffle(ids, 1234);
    expect(stableShuffle(ids, 1234)).toEqual(a);
    expect([...a].sort()).toEqual(ids);
    expect(ids).toEqual(copy);
    expect(a).not.toEqual(ids);
  });

  it('gives a different order for a different seed', () => {
    expect(stableShuffle(ids, 1)).not.toEqual(stableShuffle(ids, 2));
  });

  it('draws floats in [0, 1)', () => {
    const random = seededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const x = random();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('handles empty and single-item inputs', () => {
    expect(stableShuffle([], 5)).toEqual([]);
    expect(stableShuffle(['only'], 5)).toEqual(['only']);
  });
});

describe('signed cursor', () => {
  const secret = 'test-secret-'.padEnd(40, 'x');
  const payload = { sessionId: 'session-1', nextOffset: 10, expiresAt: NOW.getTime() + 60_000 };

  it('round-trips and is opaque', () => {
    const cursor = encodeCursor(payload, secret);
    expect(cursor).not.toContain('session-1');
    expect(decodeCursor(cursor, secret)).toEqual({ ok: true, payload });
  });

  it('rejects a payload edited to a different offset', () => {
    const [v, , sig] = encodeCursor(payload, secret).split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'session-1', o: 0, e: payload.expiresAt })).toString('base64url');
    expect(decodeCursor(`${v}.${forged}.${sig}`, secret)).toEqual({ ok: false });
  });

  it('rejects a cursor signed with another secret', () => {
    expect(decodeCursor(encodeCursor(payload, 'another-secret'.padEnd(40, 'y')), secret)).toEqual({ ok: false });
  });

  it('rejects a damaged signature', () => {
    const cursor = encodeCursor(payload, secret);
    const last = cursor.at(-1) === 'A' ? 'B' : 'A';
    expect(decodeCursor(cursor.slice(0, -1) + last, secret)).toEqual({ ok: false });
    expect(decodeCursor(cursor.slice(0, -4), secret)).toEqual({ ok: false });
  });

  it.each(['', 'garbage', 'v2.a.b', 'v1.a', 'v1.a.b.c', 'x'.repeat(600)])('rejects malformed input %#', (input) => {
    expect(decodeCursor(input, secret)).toEqual({ ok: false });
  });

  it('rejects correctly signed payloads with invalid fields', () => {
    expect(decodeCursor(encodeCursor({ ...payload, nextOffset: -1 }, secret), secret)).toEqual({ ok: false });
    expect(decodeCursor(encodeCursor({ ...payload, nextOffset: 1.5 }, secret), secret)).toEqual({ ok: false });
    expect(decodeCursor(encodeCursor({ ...payload, sessionId: '' }, secret), secret)).toEqual({ ok: false });
  });
});

describe('resolveCursorSecret', () => {
  it('uses a configured secret of at least 32 characters', () => {
    expect(resolveCursorSecret('s'.repeat(32), 'production')).toBe('s'.repeat(32));
    expect(() => resolveCursorSecret('short', 'development')).toThrow(/at least 32/);
  });

  it('is required in production', () => {
    expect(() => resolveCursorSecret(undefined, 'production')).toThrow(/required in production/);
  });

  it('falls back to a random per-process secret outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = resolveCursorSecret(undefined, 'development');
    const b = resolveCursorSecret(undefined, 'test');
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('pair exclusion providers', () => {
  it('defaults to excluding nobody', async () => {
    expect(await noPairExclusions.excludedAmong('v', ['a', 'b'])).toEqual(new Set());
  });

  it('combines providers as a union and skips empty batches', async () => {
    const blocks = { excludedAmong: vi.fn(async () => new Set(['a'])) };
    const hides = { excludedAmong: vi.fn(async () => new Set(['b'])) };
    const combined = combineExclusions(blocks, hides);
    expect(await combined.excludedAmong('v', ['a', 'b', 'c'])).toEqual(new Set(['a', 'b']));
    expect(await combined.excludedAmong('v', [])).toEqual(new Set());
    expect(blocks.excludedAmong).toHaveBeenCalledTimes(1);
  });
});
