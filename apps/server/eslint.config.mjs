import config from '../../eslint.config.mjs';

export default [
  ...config,
  {
    // The tests have their own test/tsconfig.json. The Vitest config sits outside both.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['vitest.config.ts'] } },
    },
  },
];
