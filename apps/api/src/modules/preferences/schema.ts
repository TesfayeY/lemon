/**
 * Dating preferences schema.
 *
 * - Age range: min 18, max configurable
 * - Gender interests: multi-select from catalog
 * - Location scope: city, state, nationwide
 * - Long distance: boolean
 */

export type LocationScope = 'city' | 'state' | 'nationwide';

export interface PreferencesDocument {
  _id: string; // same as userId
  userId: string;
  acceptedGenderCategories: string[]; // catalog IDs
  minAge: number;
  maxAge: number;
  locationScope: LocationScope;
  longDistance: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export function createDefaultPreferences(userId: string): PreferencesDocument {
  const now = new Date();
  return {
    _id: userId,
    userId,
    acceptedGenderCategories: [],
    minAge: 18,
    maxAge: 50,
    locationScope: 'state',
    longDistance: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}
