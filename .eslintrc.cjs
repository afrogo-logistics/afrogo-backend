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
    '@typescript-eslint/no-explicit-any': 'off', // Turn off globally, enable for specific fixed files
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/ban-ts-comment': 'off', // Allow @ts-ignore for AWS SDK and other library type issues
    '@typescript-eslint/no-unused-vars': 'off', // Turn off globally
    '@typescript-eslint/no-non-null-assertion': 'off' // Turn off globally
  },
  overrides: [
    {
      files: ['*.js', '*.cjs'],
      parser: 'espree',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-explicit-any': 'off'
      }
    },
    // Enforce strict rules on files we've fixed
    {
      files: [
        'services/ops-service/src/pg-client.ts',
        'services/billing-service/src/ledger/merchant-ledger.ts',
        'lib/pg-client.ts',
        'lib/pdf-generator.ts',
        'services/billing-service/src/lib/pdf-generator.ts'
      ],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        '@typescript-eslint/no-var-requires': 'error'
      }
    }
  ]
};

