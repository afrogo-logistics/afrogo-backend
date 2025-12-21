module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true
  },
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./tsconfig.eslint.json']
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    'no-console': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/ban-ts-comment': 'warn'
  },
  overrides: [
    {
      // Disable type-aware linting for .js files
      files: ['*.js', '**/*.js'],
      parserOptions: {
        project: null
      }
    }
  ]
};

