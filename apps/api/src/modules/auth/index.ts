export { createAuthMiddleware, type AuthenticatedRequest } from './middleware.js';
export { createAuthRoutes } from './routes.js';
export { AccountStatus, canAuthenticate, canInteract, type UserDocument } from './account.js';
export { parseBirthDate, calculateAge, isAdultEligible, adultBoundaryDate } from './adult-gate.js';
