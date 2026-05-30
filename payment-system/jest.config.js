module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  setupFilesAfterEnv: ['./tests/setup.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 65,
      lines: 65,
    },
  },
  coverageReporters: ['text', 'lcov'],
  testMatch: ['**/tests/**/*.test.js'],
};
