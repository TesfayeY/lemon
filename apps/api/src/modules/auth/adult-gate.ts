/**
 * Adult eligibility calculation.
 *
 * Rules:
 * - Server calculates eligibility from validated birth date, never from client-supplied age.
 * - Uses ISO Gregorian dates with UTC day boundary.
 * - Minimum age: 18 years.
 * - Feb 29 birthdays: person turns 18 on March 1 in non-leap years.
 * - DOB is private; only computed age is exposed publicly.
 */

const MINIMUM_AGE = 18;

/**
 * Validates a birth date string and returns a Date if valid.
 * Rejects future dates, non-ISO formats, and impossible calendar dates.
 */
export function parseBirthDate(input: string): { valid: true; date: Date } | { valid: false; reason: string } {
  // Must be YYYY-MM-DD format
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) {
    return { valid: false, reason: 'Birth date must be in YYYY-MM-DD format' };
  }

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);

  // Basic range checks
  if (month < 1 || month > 12) {
    return { valid: false, reason: 'Invalid month' };
  }
  if (day < 1 || day > 31) {
    return { valid: false, reason: 'Invalid day' };
  }

  // Construct date and verify it roundtrips (catches things like Feb 30)
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { valid: false, reason: 'Invalid calendar date' };
  }

  // No future dates
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (date > today) {
    return { valid: false, reason: 'Birth date cannot be in the future' };
  }

  // Reasonable age limit (no one is 150+)
  if (year < today.getUTCFullYear() - 150) {
    return { valid: false, reason: 'Invalid birth year' };
  }

  return { valid: true, date };
}

/**
 * Calculates age in complete years as of today UTC.
 * Feb 29 birthday: in non-leap years, the birthday is treated as March 1.
 */
export function calculateAge(birthDate: Date, asOf?: Date): number {
  const now = asOf ?? new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const birthYear = birthDate.getUTCFullYear();
  const birthMonth = birthDate.getUTCMonth();
  const birthDay = birthDate.getUTCDate();

  let age = today.getUTCFullYear() - birthYear;

  // Check if birthday has occurred this year
  const todayMonth = today.getUTCMonth();
  const todayDay = today.getUTCDate();

  if (todayMonth < birthMonth || (todayMonth === birthMonth && todayDay < birthDay)) {
    age--;
  }

  return age;
}

/**
 * Determines if a person is an adult (18+) based on their birth date.
 */
export function isAdultEligible(birthDate: Date, asOf?: Date): boolean {
  return calculateAge(birthDate, asOf) >= MINIMUM_AGE;
}

/**
 * Returns the earliest birth date that makes someone exactly the minimum age today.
 * Useful for testing boundary conditions.
 */
export function adultBoundaryDate(asOf?: Date): Date {
  const now = asOf ?? new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear() - MINIMUM_AGE,
    now.getUTCMonth(),
    now.getUTCDate()
  ));
}
