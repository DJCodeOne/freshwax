import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import eslintPluginAstro from 'eslint-plugin-astro';

// Shared rules applied to both .ts and .astro frontmatter
const sharedRules = {
  // --- ESLint core: catch real errors ---
  'no-cond-assign': 'error',
  'no-constant-condition': 'warn',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-ex-assign': 'error',
  'no-extra-boolean-cast': 'warn',
  'no-func-assign': 'error',
  'no-inner-declarations': 'error',
  'no-irregular-whitespace': 'error',
  'no-loss-of-precision': 'error',
  'no-obj-calls': 'error',
  'no-prototype-builtins': 'warn',
  'no-sparse-arrays': 'error',
  'no-template-curly-in-string': 'warn',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',

  // --- Best practices: prevent common bugs ---
  'eqeqeq': ['warn', 'smart'],
  'no-caller': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-wrappers': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-throw-literal': 'error',
  'no-unused-expressions': ['warn', { allowShortCircuit: true, allowTernary: true }],
  'prefer-promise-reject-errors': 'warn',
  'no-console': ['warn', { allow: ['error'] }],

  // --- TypeScript-specific: catch type errors ---
  // Disable base rules that conflict with TS versions
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  'no-redeclare': 'off',
  '@typescript-eslint/no-redeclare': 'error',
  '@typescript-eslint/no-duplicate-enum-values': 'error',
  '@typescript-eslint/no-extra-non-null-assertion': 'error',
  '@typescript-eslint/no-misused-new': 'error',
  '@typescript-eslint/no-namespace': 'warn',
  '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
  '@typescript-eslint/no-this-alias': 'warn',
  '@typescript-eslint/prefer-as-const': 'warn',
  '@typescript-eslint/no-explicit-any': 'warn',
};

// Type-aware rules (require parserOptions.project)
const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-misused-promises': ['warn', {
    checksVoidReturn: false, // Allow async functions in void-returning positions (common in handlers)
  }],
};

export default [
  // Global ignores
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.astro/**',
      'workers/**',
      'public/**',
      'scripts/**',
    ],
  },

  // Astro plugin recommended config (parser + processor setup for .astro files)
  ...eslintPluginAstro.configs['flat/recommended'],

  // TypeScript files in src/ — type-aware linting
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        projectService: {
          allowDefaultProject: ['src/pages/.well-known/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...sharedRules,
      ...typeAwareRules,
    },
  },

  // Astro frontmatter — type-aware linting
  // The astro plugin sets up astro-eslint-parser for *.astro files,
  // but we need to add our rules and type-aware config for the TS inside them
  {
    files: ['src/**/*.astro'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    languageOptions: {
      parserOptions: {
        parser: tsparser,
        projectService: {
          allowDefaultProject: ['*.astro'],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.astro'],
      },
    },
    rules: {
      ...sharedRules,
      ...typeAwareRules,
    },
  },

  // Astro inline script blocks (*.astro/*.ts) — the astro plugin extracts these
  // Apply shared rules but NOT type-aware (project parsing doesn't work on virtual files)
  {
    files: ['src/**/*.astro/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...sharedRules,
    },
  },
];
