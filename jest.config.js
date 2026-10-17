// Jest runs the JavaScript that tsc compiled into dist-test/ (npm run
// build:test), never the TypeScript itself. It's ESM, so Node needs
// --experimental-vm-modules, which the npm scripts pass.
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/dist-test/test'],
  testMatch: ['**/*.spec.js'],
  // Already compiled: no Babel transform on top.
  transform: {},
  setupFiles: ['reflect-metadata'],
  reporters: ['default'],
  maxWorkers: 1,
  // Starting a Postgres container and migrating it takes seconds.
  testTimeout: 60_000,
};
