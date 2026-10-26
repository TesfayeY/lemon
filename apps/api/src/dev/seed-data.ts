/**
 * Fictional development profiles. Every person here is invented; never add
 * real people, photos or contact details.
 *
 * Seeded prompt answers are stored as already published fixture content so
 * profiles render in local builds. This does not imply review exists: real
 * submissions always start pending. Seeded accounts stay not-ready until
 * photos exist (Phase 05).
 */

import { createNewUser, type UserDocument } from '../modules/auth/account.js';
import { createEmptyProfile, type ProfileDocument, type PromptAnswerDocument } from '../modules/profiles/schema.js';
import { createDefaultPreferences, type PreferencesDocument } from '../modules/preferences/schema.js';
import { findCity } from '../modules/catalogs/data.js';

interface SeedPerson {
  displayName: string;
  birthDate: string;
  genderIdentity: string;
  interestedIn: string[];
  cityId: string;
  intention: string;
  bio: string;
  languages: string[];
  occupation: string | null;
  prompts: [promptId: string, text: string][];
  ageRange: [number, number];
}

const PEOPLE: SeedPerson[] = [
  {
    displayName: 'Selam', birthDate: '1995-03-10', genderIdentity: 'woman', interestedIn: ['man'],
    cityId: 'city-dallas-tx', intention: 'serious', bio: 'Weekend hikes, Sunday buna with friends.',
    languages: ['tigrinya', 'english'], occupation: 'Pharmacist', ageRange: [27, 38],
    prompts: [
      ['prompt-tradition', 'The full coffee ceremony, three rounds.'],
      ['prompt-sunday', 'Church, a long brunch, then a call home.'],
      ['prompt-green-flag', 'Remembering the small things I mention.'],
    ],
  },
  {
    displayName: 'Dawit', birthDate: '1991-11-02', genderIdentity: 'man', interestedIn: ['woman'],
    cityId: 'city-dc-dc', intention: 'serious', bio: 'Civil engineer. Learning to cook my mom\'s shiro.',
    languages: ['amharic', 'english'], occupation: 'Civil engineer', ageRange: [25, 36],
    prompts: [
      ['prompt-cooking', 'Shiro that almost matches my mom\'s.'],
      ['prompt-home', 'Piazza on a rainy afternoon.'],
      ['prompt-first-date', 'A walk along the Wharf and good tibs after.'],
    ],
  },
  {
    displayName: 'ሄለን Helen', birthDate: '1998-07-21', genderIdentity: 'woman', interestedIn: ['man'],
    cityId: 'city-silver-spring-md', intention: 'exploring', bio: 'Nursing student, part-time poet.',
    languages: ['amharic', 'english'], occupation: null, ageRange: [23, 33],
    prompts: [
      ['prompt-song', 'Anything by Aster Aweke on a long drive.'],
      ['prompt-learning', 'That rest is productive too.'],
      ['prompt-weekend', 'At the farmers market, then writing in a café.'],
    ],
  },
  {
    displayName: 'Yonas', birthDate: '1988-01-30', genderIdentity: 'man', interestedIn: ['woman'],
    cityId: 'city-seattle-wa', intention: 'serious', bio: 'Software tester, soccer on Saturdays.',
    languages: ['tigrinya', 'amharic', 'english'], occupation: 'QA engineer', ageRange: [28, 40],
    prompts: [
      ['prompt-tradition', 'Hosting Meskel with too much food.'],
      ['prompt-conversation', 'Whether Arsenal will ever win the league.'],
      ['prompt-looking-for', 'Someone who laughs easily and plans trips.'],
    ],
  },
  {
    displayName: 'Meron', birthDate: '1993-05-14', genderIdentity: 'woman', interestedIn: ['man', 'nonbinary'],
    cityId: 'city-atlanta-ga', intention: 'unsure', bio: 'Accountant by day, dancer by night.',
    languages: ['amharic', 'english'], occupation: 'Accountant', ageRange: [26, 39],
    prompts: [
      ['prompt-family-taught', 'Always bring something when you visit.'],
      ['prompt-travel', 'Lalibela, then Zanzibar.'],
      ['prompt-cared-for', 'A text that says "home safe?"'],
    ],
  },
  {
    displayName: 'Natnael', birthDate: '1996-09-08', genderIdentity: 'man', interestedIn: ['woman'],
    cityId: 'city-minneapolis-mn', intention: 'exploring', bio: 'Grad student. Will talk about history all day.',
    languages: ['afaan-oromo', 'amharic', 'english'], occupation: null, ageRange: [22, 32],
    prompts: [
      ['prompt-conversation', 'How cities remember their own history.'],
      ['prompt-background', 'Growing up between Adama and Minneapolis.'],
      ['prompt-sunday', 'Pickup basketball and a slow dinner.'],
    ],
  },
  {
    displayName: 'Eden', birthDate: '1990-12-03', genderIdentity: 'nonbinary', interestedIn: ['woman', 'nonbinary'],
    cityId: 'city-denver-co', intention: 'serious', bio: 'Graphic designer and trail runner.',
    languages: ['tigrinya', 'english'], occupation: 'Designer', ageRange: [27, 40],
    prompts: [
      ['prompt-weekend', 'On a trail before sunrise.'],
      ['prompt-green-flag', 'Being kind to servers.'],
      ['prompt-home', 'My grandmother\'s kitchen in Keren.'],
    ],
  },
  {
    displayName: 'Robel', birthDate: '1994-04-17', genderIdentity: 'man', interestedIn: ['woman'],
    cityId: 'city-alexandria-va', intention: 'serious', bio: 'Paramedic. Calm in a crisis, chaotic at karaoke.',
    languages: ['tigrinya', 'tigre', 'english'], occupation: 'Paramedic', ageRange: [25, 35],
    prompts: [
      ['prompt-first-date', 'Karaoke. I promise to go first.'],
      ['prompt-family-taught', 'Show up for people, especially when it is hard.'],
      ['prompt-looking-for', 'A partner who wants a full, loud home.'],
    ],
  },
];

export interface SeedDocuments {
  users: UserDocument[];
  profiles: ProfileDocument[];
  preferences: PreferencesDocument[];
  promptAnswers: PromptAnswerDocument[];
}

/** Build seed documents with stable IDs so re-seeding replaces rather than duplicates */
export function buildSeedDocuments(): SeedDocuments {
  const docs: SeedDocuments = { users: [], profiles: [], preferences: [], promptAnswers: [] };

  PEOPLE.forEach((person, i) => {
    const n = String(i + 1).padStart(2, '0');
    const userId = `seed-user-${n}`;
    const now = new Date();

    docs.users.push({
      ...createNewUser(userId, `seed-firebase-uid-${n}`),
      emailVerified: true,
      birthDate: person.birthDate,
      adultEligible: true,
      agreements: { termsVersion: '1.0', acceptedAt: now },
    });

    docs.profiles.push({
      ...createEmptyProfile(userId),
      displayName: person.displayName,
      genderIdentity: person.genderIdentity,
      cityId: person.cityId,
      stateCode: findCity(person.cityId)!.stateCode,
      intention: person.intention,
      bio: person.bio,
      languages: person.languages,
      occupation: person.occupation,
      occupationDisplay: person.occupation ? 'public' : 'private',
    });

    docs.preferences.push({
      ...createDefaultPreferences(userId),
      acceptedGenderCategories: person.interestedIn,
      minAge: person.ageRange[0],
      maxAge: person.ageRange[1],
    });

    person.prompts.forEach(([promptId, text], j) => {
      docs.promptAnswers.push({
        _id: `seed-answer-${n}-${j + 1}`,
        ownerId: userId,
        promptId,
        slot: j,
        approvedText: text,
        pendingText: null,
        state: 'approved',
        revision: 1,
        publishedRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
  });

  return docs;
}
