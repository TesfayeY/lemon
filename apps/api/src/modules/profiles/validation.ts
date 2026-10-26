import { graphemeLength, normalizeWhitespace, OPTIONAL_TEXT_MAX } from './schema.js';
import { isValidCityId, isValidGenderId, isValidIntentionId, isValidLanguageId, isValidPromptId } from '../catalogs/data.js';

export interface FieldError {
  field: string;
  message: string;
}

export function validateDisplayName(name: unknown): FieldError | null {
  if (typeof name !== 'string') return { field: 'displayName', message: 'Must be a string' };
  const normalized = normalizeWhitespace(name);
  if (normalized.length === 0) return { field: 'displayName', message: 'Name is required' };
  const len = graphemeLength(normalized);
  if (len > 40) return { field: 'displayName', message: 'Name must be 40 characters or fewer' };
  return null;
}

export function validateGenderIdentity(id: unknown): FieldError | null {
  if (typeof id !== 'string') return { field: 'genderIdentity', message: 'Must be a string' };
  if (!isValidGenderId(id)) return { field: 'genderIdentity', message: 'Unknown gender category' };
  return null;
}

export function validateIntention(id: unknown): FieldError | null {
  if (typeof id !== 'string') return { field: 'intention', message: 'Must be a string' };
  if (!isValidIntentionId(id)) return { field: 'intention', message: 'Unknown intention' };
  return null;
}

export function validateCity(cityId: unknown): FieldError | null {
  if (typeof cityId !== 'string') return { field: 'cityId', message: 'Must be a string' };
  if (!isValidCityId(cityId)) return { field: 'cityId', message: 'Unknown city' };
  return null;
}

export function validateVisibility(value: unknown, field: string): FieldError | null {
  if (value !== 'public' && value !== 'private') {
    return { field, message: 'Must be "public" or "private"' };
  }
  return null;
}

export function validateBio(bio: unknown): FieldError | null {
  if (bio === null || bio === undefined) return null;
  if (typeof bio !== 'string') return { field: 'bio', message: 'Must be a string' };
  const len = graphemeLength(bio);
  if (len > 500) return { field: 'bio', message: 'Bio must be 500 characters or fewer' };
  return null;
}

export function validatePromptAnswer(text: unknown): FieldError | null {
  if (typeof text !== 'string') return { field: 'text', message: 'Must be a string' };
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return { field: 'text', message: 'Answer is required' };
  const len = graphemeLength(normalized);
  if (len > 300) return { field: 'text', message: 'Answer must be 300 characters or fewer' };
  return null;
}

export function validatePromptId(id: unknown): FieldError | null {
  if (typeof id !== 'string') return { field: 'promptId', message: 'Must be a string' };
  if (!isValidPromptId(id)) return { field: 'promptId', message: 'Unknown or inactive prompt' };
  return null;
}

export function validateHeight(height: unknown): FieldError | null {
  if (height === null || height === undefined) return null;
  if (typeof height !== 'number' || !Number.isInteger(height)) {
    return { field: 'height', message: 'Must be an integer (cm)' };
  }
  if (height < 100 || height > 250) {
    return { field: 'height', message: 'Height must be between 100 and 250 cm' };
  }
  return null;
}

export function validateOptionalText(value: unknown, field: string): FieldError | null {
  if (value === null) return null;
  if (typeof value !== 'string') return { field, message: 'Must be a string or null' };
  if (graphemeLength(normalizeWhitespace(value)) > OPTIONAL_TEXT_MAX) {
    return { field, message: `Must be ${OPTIONAL_TEXT_MAX} characters or fewer` };
  }
  return null;
}

export function validateLanguages(ids: unknown): FieldError | null {
  if (!Array.isArray(ids)) return { field: 'languages', message: 'Must be an array' };
  if (!ids.every(id => typeof id === 'string' && isValidLanguageId(id))) {
    return { field: 'languages', message: 'Contains unknown language' };
  }
  return null;
}
