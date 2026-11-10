/**
 * US location policy for discovery (D-08: city-based, no GPS).
 *
 * Proposed mutual rule from the spec ("US community and location rules"):
 * a pair is geographically eligible only if BOTH users' selected scopes
 * include the other's current residence.
 *
 * - city:       same catalog city ID, or the same explicit catalog metro group.
 *               City IDs are the identity, so two cities that share a name in
 *               different states never match each other.
 * - state:      same US state code.
 * - nationwide: anywhere in the US; only when explicitly selected.
 *
 * Residence must resolve against the configured catalog: a city ID that is
 * missing (stale), non-US, or whose stored state disagrees with the catalog
 * keeps that person out of the pool. `longDistance` never widens a hard scope,
 * and hometown is never read here — it is profile context, not residence.
 *
 * P-07 (launch metros) is open: the catalog is injectable, metro membership is
 * explicit per city, and no mileage around a city centre is ever inferred.
 */

import { findCity } from '../catalogs/data.js';
import type { LocationScope } from '../preferences/schema.js';

export interface DiscoveryCity {
  id: string;
  stateCode: string;
  countryCode: string;
  /** Explicit metro group membership; absent means the city stands alone. */
  metroId?: string;
}

export interface LocationCatalog {
  findCity(id: string): DiscoveryCity | undefined;
  /** Every city ID in a metro group (including the asked-about city). */
  metroCityIds?(metroId: string): string[];
}

/** The shared US city catalog. It defines no metro groups until P-07 is decided. */
export const defaultLocationCatalog: LocationCatalog = { findCity };

export interface Residence {
  cityId: string;
  stateCode: string;
  metroId: string | null;
}

export interface StoredLocation {
  cityId: string | null;
  stateCode: string | null;
  countryCode: string | null;
}

/** Current US residence from stored profile fields, or null if it can't take part in discovery. */
export function resolveResidence(location: StoredLocation, catalog: LocationCatalog): Residence | null {
  if (!location.cityId || location.countryCode !== 'US') return null;
  const city = catalog.findCity(location.cityId);
  if (!city || city.countryCode !== 'US') return null;
  // A stored state that disagrees with the catalog is stale data; fail closed
  if (location.stateCode !== city.stateCode) return null;
  return { cityId: city.id, stateCode: city.stateCode, metroId: city.metroId ?? null };
}

/** Whether `own`'s selected scope includes `other`'s residence (one direction). */
export function scopeIncludes(scope: LocationScope, own: Residence, other: Residence): boolean {
  switch (scope) {
    case 'city':
      return own.cityId === other.cityId || (own.metroId !== null && own.metroId === other.metroId);
    case 'state':
      return own.stateCode === other.stateCode;
    case 'nationwide':
      return true;
    default:
      return false; // unknown scope fails closed
  }
}

export interface LocatedParticipant {
  residence: Residence;
  scope: LocationScope;
}

/** Mutual rule: each person's scope must include the other's residence. */
export function locationsCompatible(a: LocatedParticipant, b: LocatedParticipant): boolean {
  return scopeIncludes(a.scope, a.residence, b.residence) && scopeIncludes(b.scope, b.residence, a.residence);
}

/**
 * Mongo filter narrowing profiles to those inside the viewer's own scope.
 * Only a pre-filter: the reverse direction and catalog validity are
 * enforced by the pure eligibility check on every page.
 */
export function viewerScopeFilter(
  scope: LocationScope,
  residence: Residence,
  metroCityIds: readonly string[],
): Record<string, unknown> {
  switch (scope) {
    case 'city':
      return metroCityIds.length > 1 ? { cityId: { $in: [...metroCityIds] } } : { cityId: residence.cityId };
    case 'state':
      return { stateCode: residence.stateCode };
    default:
      return {};
  }
}
