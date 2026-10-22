import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      PORT: '3001',
      MONGO_URI: 'mongodb://localhost:27017/?replicaSet=rs0',
      MONGO_DB_NAME: 'lemon_test',
      FIREBASE_PROJECT_ID: 'lemon-dev',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    },
  },
});
