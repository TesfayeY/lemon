/**
 * Static catalog data for the Lemon app.
 * US cities, states, prompts, intentions, and gender categories.
 *
 * These are stable IDs independent of translated text.
 * Cities are a seed set — a full catalog will be loaded from DB in production.
 */

export interface City {
  id: string;
  name: string;
  stateCode: string;
  countryCode: 'US';
}

export interface UsState {
  code: string;
  name: string;
}

export interface PromptCatalogItem {
  id: string;
  category: 'general' | 'cultural' | 'lifestyle' | 'dating';
  text: string;
  active: boolean;
}

export interface IntentionOption {
  id: string;
  label: string;
}

export interface GenderCategory {
  id: string;
  label: string;
}

// US States (abbreviated set for launch)
export const US_STATES: UsState[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MO', name: 'Missouri' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NY', name: 'New York' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WI', name: 'Wisconsin' },
];

// Seed cities — same name + different state must remain distinct
export const SEED_CITIES: City[] = [
  { id: 'city-seattle-wa', name: 'Seattle', stateCode: 'WA', countryCode: 'US' },
  { id: 'city-dallas-tx', name: 'Dallas', stateCode: 'TX', countryCode: 'US' },
  { id: 'city-houston-tx', name: 'Houston', stateCode: 'TX', countryCode: 'US' },
  { id: 'city-austin-tx', name: 'Austin', stateCode: 'TX', countryCode: 'US' },
  { id: 'city-dc-dc', name: 'Washington', stateCode: 'DC', countryCode: 'US' },
  { id: 'city-silver-spring-md', name: 'Silver Spring', stateCode: 'MD', countryCode: 'US' },
  { id: 'city-alexandria-va', name: 'Alexandria', stateCode: 'VA', countryCode: 'US' },
  { id: 'city-los-angeles-ca', name: 'Los Angeles', stateCode: 'CA', countryCode: 'US' },
  { id: 'city-san-jose-ca', name: 'San Jose', stateCode: 'CA', countryCode: 'US' },
  { id: 'city-san-diego-ca', name: 'San Diego', stateCode: 'CA', countryCode: 'US' },
  { id: 'city-new-york-ny', name: 'New York', stateCode: 'NY', countryCode: 'US' },
  { id: 'city-atlanta-ga', name: 'Atlanta', stateCode: 'GA', countryCode: 'US' },
  { id: 'city-minneapolis-mn', name: 'Minneapolis', stateCode: 'MN', countryCode: 'US' },
  { id: 'city-columbus-oh', name: 'Columbus', stateCode: 'OH', countryCode: 'US' },
  { id: 'city-denver-co', name: 'Denver', stateCode: 'CO', countryCode: 'US' },
  { id: 'city-chicago-il', name: 'Chicago', stateCode: 'IL', countryCode: 'US' },
  { id: 'city-portland-or', name: 'Portland', stateCode: 'OR', countryCode: 'US' },
  { id: 'city-las-vegas-nv', name: 'Las Vegas', stateCode: 'NV', countryCode: 'US' },
  { id: 'city-phoenix-az', name: 'Phoenix', stateCode: 'AZ', countryCode: 'US' },
  { id: 'city-philadelphia-pa', name: 'Philadelphia', stateCode: 'PA', countryCode: 'US' },
];

// Prompt catalog with stable IDs
export const PROMPT_CATALOG: PromptCatalogItem[] = [
  // Cultural
  { id: 'prompt-tradition', category: 'cultural', text: 'A tradition I would love to share with you…', active: true },
  { id: 'prompt-home', category: 'cultural', text: 'A place that feels like home…', active: true },
  { id: 'prompt-family-taught', category: 'cultural', text: 'Something my family taught me…', active: true },
  { id: 'prompt-background', category: 'cultural', text: 'A part of my background I would love to share…', active: true },
  { id: 'prompt-song', category: 'cultural', text: 'The song I always come back to…', active: true },

  // General
  { id: 'prompt-sunday', category: 'general', text: 'My ideal Sunday looks like…', active: true },
  { id: 'prompt-cared-for', category: 'general', text: 'A small thing that makes me feel cared for…', active: true },
  { id: 'prompt-conversation', category: 'general', text: 'A conversation I could have for hours…', active: true },
  { id: 'prompt-learning', category: 'general', text: 'Something I am learning about myself…', active: true },

  // Dating
  { id: 'prompt-first-date', category: 'dating', text: 'A first date I would enjoy…', active: true },
  { id: 'prompt-looking-for', category: 'dating', text: 'What I am looking for…', active: true },
  { id: 'prompt-green-flag', category: 'dating', text: 'A green flag I always notice…', active: true },

  // Lifestyle
  { id: 'prompt-weekend', category: 'lifestyle', text: 'On a free weekend you will find me…', active: true },
  { id: 'prompt-cooking', category: 'lifestyle', text: 'The best thing I can cook…', active: true },
  { id: 'prompt-travel', category: 'lifestyle', text: 'A place I dream of visiting…', active: true },
];

// Relationship intentions
export const INTENTIONS: IntentionOption[] = [
  { id: 'serious', label: 'Looking for something serious' },
  { id: 'exploring', label: 'Open to exploring' },
  { id: 'unsure', label: 'Not sure yet' },
];

// Gender categories — inclusive, with optional self-description
export const GENDER_CATEGORIES: GenderCategory[] = [
  { id: 'woman', label: 'Woman' },
  { id: 'man', label: 'Man' },
  { id: 'nonbinary', label: 'Nonbinary' },
];

// Lookup helpers
const cityMap = new Map(SEED_CITIES.map(c => [c.id, c]));
const stateMap = new Map(US_STATES.map(s => [s.code, s]));
const promptMap = new Map(PROMPT_CATALOG.map(p => [p.id, p]));
const intentionMap = new Map(INTENTIONS.map(i => [i.id, i]));
const genderMap = new Map(GENDER_CATEGORIES.map(g => [g.id, g]));

export function findCity(id: string): City | undefined { return cityMap.get(id); }
export function findState(code: string): UsState | undefined { return stateMap.get(code); }
export function findPrompt(id: string): PromptCatalogItem | undefined { return promptMap.get(id); }
export function findIntention(id: string): IntentionOption | undefined { return intentionMap.get(id); }
export function findGender(id: string): GenderCategory | undefined { return genderMap.get(id); }
export function isValidCityId(id: string): boolean { return cityMap.has(id); }
export function isValidPromptId(id: string): boolean {
  const p = promptMap.get(id);
  return !!p && p.active;
}
export function isValidIntentionId(id: string): boolean { return intentionMap.has(id); }
export function isValidGenderId(id: string): boolean { return genderMap.has(id); }
