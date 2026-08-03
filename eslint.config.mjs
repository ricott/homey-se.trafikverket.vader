import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            '.homeybuild/**',
            'node_modules/**',
            'app.json',
            // Untracked, developer-local API credentials.
            'test/config.js',
        ],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: true,
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-var': 'error',
            'prefer-const': 'error',
            'prefer-template': 'error',
            'object-shorthand': ['error', 'always'],
            'prefer-arrow-callback': 'error',
            // Not `require-await`: Homey SDK lifecycle hooks (onInit, onSettings,
            // onUninit, ...) are async by contract even when they don't await.
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            curly: ['error', 'all'],
        },
    },
    {
        // Mocha specs
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            // Mocha exposes this.timeout()/this.skip() on the test context,
            // which arrow functions cannot reach.
            'prefer-arrow-callback': 'off',
        },
    },
];
