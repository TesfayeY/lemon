import { z } from 'zod';

export const AccountStatus = {
  ONBOARDING: 'onboarding',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DELETION_PENDING: 'deletion_pending',
  DELETED: 'deleted',
} as const;

export type AccountStatusType = (typeof AccountStatus)[keyof typeof AccountStatus];

/** Statuses that can browse discovery, like, or send messages */
const INTERACTIVE_STATUSES: readonly AccountStatusType[] = [
  AccountStatus.ACTIVE,
] as const;

/** Statuses that can sign in at all */
const AUTHENTICATED_STATUSES: readonly AccountStatusType[] = [
  AccountStatus.ONBOARDING,
  AccountStatus.ACTIVE,
] as const;

export function canInteract(status: AccountStatusType): boolean {
  return (INTERACTIVE_STATUSES as readonly string[]).includes(status);
}

export function canAuthenticate(status: AccountStatusType): boolean {
  return (AUTHENTICATED_STATUSES as readonly string[]).includes(status);
}

/**
 * Set when an under-18 birth date was refused. Records the fact and when, never
 * the date. Private: no DTO, public or staff, carries it.
 */
export interface AgeGateRecord {
  blockedAt: Date;
}

export interface UserDocument {
  _id: string;
  firebaseUid: string;
  accountStatus: AccountStatusType;
  emailVerified: boolean;
  birthDate: string | null;
  adultEligible: boolean;
  /**
   * Absent or null: no birth date has been refused. Once set, every birth date
   * submission is refused; date changes go through support (spec §4.1).
   */
  ageGate?: AgeGateRecord | null;
  discoverPaused: boolean;
  profileReady: boolean;
  guardVersion: number;
  agreements: {
    termsVersion: string | null;
    acceptedAt: Date | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

export const bootstrapSchema = z.object({}).strict();

export function createNewUser(id: string, firebaseUid: string): UserDocument {
  const now = new Date();
  return {
    _id: id,
    firebaseUid,
    accountStatus: AccountStatus.ONBOARDING,
    emailVerified: false,
    birthDate: null,
    adultEligible: false,
    ageGate: null,
    discoverPaused: false,
    profileReady: false,
    guardVersion: 1,
    agreements: {
      termsVersion: null,
      acceptedAt: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}
