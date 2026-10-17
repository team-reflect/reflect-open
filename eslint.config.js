import { defineESLintConfig } from '@ocavue/eslint-config'

// Lint rules that keep the service architecture (`docs/contributing/services.md`).
// Each block names the rule of the architecture that it protects. An exception
// is a file in a list here, with its reason: never an inline disable comment.

const SOURCE_EXTENSIONS = '{ts,tsx}'

/**
 * `vi.mock` / `vi.doMock` only for the listed module specifiers. An entry that
 * ends in `*` allows every specifier with that prefix.
 */
const viMockAllowlistRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      notAllowed:
        '`vi.mock` of "{{specifier}}" is not on the allowlist. Build `createTestCoreServices()` and render with `renderInApp` (seed a test double or spy on `app.<service>`), or mount the real provider in `wrapper`. Only a pure UI child or a heavy child may be mocked: list it in `eslint.config.js` with a reason.',
      notLiteral: 'Pass the module specifier of `vi.mock` as a string literal.',
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? []
    const isAllowed = (specifier) =>
      allow.some((entry) =>
        entry.endsWith('*') ? specifier.startsWith(entry.slice(0, -1)) : specifier === entry,
      )
    return {
      CallExpression(node) {
        const { callee } = node
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'vi' ||
          callee.property.type !== 'Identifier' ||
          (callee.property.name !== 'mock' && callee.property.name !== 'doMock')
        ) {
          return
        }
        const [first] = node.arguments
        if (first?.type !== 'Literal' || typeof first.value !== 'string') {
          context.report({ node, messageId: 'notLiteral' })
          return
        }
        if (!isAllowed(first.value)) {
          context.report({ node, messageId: 'notAllowed', data: { specifier: first.value } })
        }
      },
    }
  },
}

const architecturePlugin = { rules: { 'vi-mock-allowlist': viMockAllowlistRule } }

// ---------------------------------------------------------------------------
// `vi.mock` allowlists
// ---------------------------------------------------------------------------

/** Mocked in any desktop test: pure UI children and heavy children. */
const DESKTOP_VI_MOCK_ALLOW = [
  // Vaul's drag and animation are verified on a device; tests use a passthrough.
  '@/components/ui/drawer.tsx',
  // The Base UI toast manager needs its viewport; tests record the `toast.add` calls.
  '@/components/ui/toast.tsx',
  // The ProseKit editor: a test of a screen around it uses a probe.
  '@/editor/note-editor.tsx',
  // The read-only Markdown renderer loads the same editor stack.
  '@/editor/markdown-preview.tsx',
  // The carousel engine measures real layout; tests script its API.
  'embla-carousel-react',
]

/** Extra specifiers for one desktop test file, each with its reason. */
const DESKTOP_VI_MOCK_ALLOW_BY_FILE = {
  // Platform adapters: the test stands in for the Tauri API under the adapter.
  'apps/desktop/src/services/*.test.ts': ['@tauri-apps/*'],

  // Shell tests about layout and routing: the sibling screens are probes.
  'apps/desktop/src/components/workspace-content.test.tsx': [
    '@/components/command-palette/command-palette.tsx',
    '@/components/context-sidebar/daily-context-sidebar.tsx',
    '@/components/context-sidebar/note-context-sidebar.tsx',
    '@/components/embeddings-sync.tsx',
    '@/components/note-find-bar.tsx',
    '@/components/route-content.tsx',
    '@/components/shortcuts-dialog.tsx',
    '@/components/sidebar/sidebar.tsx',
    '@/components/templates/template-create-dialog.tsx',
    '@/components/templates/template-picker.tsx',
    // The command registry hook needs every workspace provider; the shell
    // only passes its result to the (mocked) sidebar.
    '@/routing/app-shortcuts.ts',
  ],
  'apps/desktop/src/components/route-content.test.tsx': [
    '@/components/chat/chat-screen.tsx',
    '@/components/daily-stream.tsx',
    '@/components/settings-screen.tsx',
  ],
  'apps/desktop/src/mobile/screens/note.test.tsx': [
    '@/components/note-pane.tsx',
    '@/mobile/incoming-backlinks.tsx',
    '@/mobile/note-actions-menu.tsx',
  ],
  'apps/desktop/src/mobile/note-conflict.test.tsx': ['@/mobile/note-actions-menu.tsx'],
  'apps/desktop/src/mobile/screens/settings.test.tsx': ['@/mobile/connect-github-drawer.tsx'],

  // Heavy children: the pane and the task row mount the editor.
  'apps/desktop/src/components/daily-stream.focus.test.tsx': ['@/components/note-pane.tsx'],
  'apps/desktop/src/components/tasks/tasks-screen.test.tsx': ['./task-editor'],

  // The real resolver only lets `reflect-asset:` media through, which no test
  // browser can load; the mock also widens `X_MEDIA_URL_PROTOCOLS`.
  'apps/desktop/src/editor/note-editor.test.tsx': ['@/editor/use-x-post-resolver.ts'],

  // Presentation tests over every phase of the recorder. The context value is
  // scripted; the session behind it has its own tests in core and in
  // `providers/audio-memo-provider.test.tsx` / `mobile/audio-memo-provider.test.tsx`.
  'apps/desktop/src/components/audio-memo/audio-memo-button.test.tsx': [
    '@/providers/audio-memo-provider.tsx',
  ],
  'apps/desktop/src/components/sidebar/sidebar.test.tsx': ['@/providers/audio-memo-provider.tsx'],
  'apps/desktop/src/mobile/daily-capture-menu.test.tsx': ['@/mobile/audio-memo-provider.tsx'],
  'apps/desktop/src/mobile/recording-drawer.test.tsx': ['@/mobile/audio-memo-provider.tsx'],
  'apps/desktop/src/mobile/mobile-screen.test.tsx': ['@/mobile/audio-memo-provider.tsx'],
}

/**
 * The extension has no service layer: its modules reach `wxt/browser` and each
 * other directly. The list is today's mocks, so a new target still fails.
 */
const EXTENSION_VI_MOCK_ALLOW = [
  'wxt/browser',
  './bookmark-settings',
  './extract-page-text',
  './flush',
  './like-settings',
  './native',
  './use-captured-page',
  './x-save',
  '@/lib/flush',
  '@/lib/page-text',
  '@/lib/popup-preferences',
  '@/lib/save-capture',
]

function viMockBlock(files, allow) {
  return {
    files,
    plugins: { architecture: architecturePlugin },
    rules: { 'architecture/vi-mock-allowlist': ['error', { allow }] },
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const CORE_IMPORT_MESSAGE =
  '`@reflect/core` is platform-agnostic: no Tauri, no React, no TanStack, nothing from `apps/`. A platform adapter lives in `apps/desktop/src/services/` and reaches core through `createCoreServices(adapters)`.'

const APP_IMPORT_MESSAGE =
  '`@reflect/app` is the app layer over `@reflect/core`: no Tauri, no React, no TanStack, nothing from `apps/`. A platform adapter lives in `apps/desktop/src/services/` and reaches the app layer through `createAppServices(core, host)`.'

const TAURI_IMPORT_MESSAGE =
  'Only the platform adapters in `apps/desktop/src/services/` (and `boot.ts`, `main.tsx`) import `@tauri-apps/*`. Read the service from `useCoreServices()` or take it in `ctx`.'

// A selector, not `no-restricted-imports`: that rule also reports
// `import * as React from 'react'`.
const REACT_ACT_SELECTOR = {
  selector: 'ImportDeclaration[source.value="react"] > ImportSpecifier[imported.name="act"]',
  message:
    "Import `act` from '@/test-utils/act.ts': it sets `IS_REACT_ACT_ENVIRONMENT` for the scope, so React does not warn.",
}

/** `import()` of a restricted package, which `no-restricted-imports` does not see. */
function dynamicImportSelector(pattern, message) {
  return { selector: `ImportExpression[source.value=/${pattern}/]`, message }
}

// ---------------------------------------------------------------------------
// The default-instance pattern
// ---------------------------------------------------------------------------

// The two names are domain functions over a value (`defaultAiProvider(state)`,
// `defaultAttendees(event)`), not service instances.
const DEFAULT_INSTANCE_NAME =
  '/^(?!(?:defaultAiProvider|defaultAttendees)$)(?:default|setDefault)[A-Z]/'

const DEFAULT_INSTANCE_MESSAGE =
  'No process-wide service instances: `createCoreServices(adapters)` builds every service once, and a caller gets a service through `deps`, `useCoreServices()` or `ctx`. Do not export `defaultXxx()` / `setDefaultXxx()`.'

const DEFAULT_INSTANCE_SELECTORS = [
  {
    selector: `ExportNamedDeclaration > FunctionDeclaration[id.name=${DEFAULT_INSTANCE_NAME}]`,
    message: DEFAULT_INSTANCE_MESSAGE,
  },
  {
    selector: `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=${DEFAULT_INSTANCE_NAME}][init.type=/^(?:ArrowFunctionExpression|FunctionExpression)$/]`,
    message: DEFAULT_INSTANCE_MESSAGE,
  },
]

const MODULE_LET_SELECTORS = [
  {
    selector:
      ':matches(Program > VariableDeclaration[kind="let"], Program > ExportNamedDeclaration > VariableDeclaration[kind="let"])',
    message:
      'No module-level mutable state in `@reflect/core`: state lives in the `#` fields of the service that `createXxxService(deps)` builds, so each `createCoreServices()` (and each test) gets its own.',
  },
]

const CORE_DYNAMIC_IMPORT_SELECTORS = [
  dynamicImportSelector(
    String.raw`^(?:@tauri-apps\/|@tanstack\/|react(?:-dom)?(?:\/|$))`,
    CORE_IMPORT_MESSAGE,
  ),
]

// ---------------------------------------------------------------------------
// Code shape: no overloads, no accessors, `#` for private members
// ---------------------------------------------------------------------------

const ACCESSOR_MESSAGE = 'No accessors. Write getX() / setX().'
const ACCESSIBILITY_MESSAGE = 'Use # for private members; no accessibility modifiers.'

const CODE_SHAPE_SELECTORS = [
  {
    selector: 'TSDeclareFunction',
    message: 'No function overloads. Write one function per signature.',
  },
  { selector: "MethodDefinition[kind='get']", message: ACCESSOR_MESSAGE },
  { selector: "MethodDefinition[kind='set']", message: ACCESSOR_MESSAGE },
  { selector: "Property[kind='get']", message: ACCESSOR_MESSAGE },
  { selector: "Property[kind='set']", message: ACCESSOR_MESSAGE },
  { selector: 'PropertyDefinition[accessibility]', message: ACCESSIBILITY_MESSAGE },
  { selector: 'MethodDefinition[accessibility]', message: ACCESSIBILITY_MESSAGE },
  { selector: 'TSParameterProperty', message: ACCESSIBILITY_MESSAGE },
]

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

const NO_CONSOLE = [
  'error',
  {
    name: 'console',
    message:
      'Log through `LoggerService` (`deps.logger`, `useCoreServices().logger`, `ctx.logger`). A test asserts on `createTestLoggerService().getErrors()` / `getWarnings()`.',
  },
]

export default defineESLintConfig(
  {
    react: {
      version: '19.2',
      reactCompiler: true,
      files: ['**/*.tsx', './apps/desktop/src/**/*.ts'],
    },
    markdown: false,
    packageJson: false,
    command: true,
    perfectionist: false,
    jsdoc: false,
    ocavue: false,
  },
  {
    ignores: ['./design-system/', '**/.wxt/', '**/.output/'],
  },
  {
    files: ['apps/desktop/scripts/**/*.ts'],
    rules: {
      curly: ['error', 'all'],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    // Disable some rules temporarily
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    /// keep-sorted
    rules: {
      '@eslint-react/dom-no-flush-sync': 'off',
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/naming-convention-ref-name': 'off',
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/use-state': 'off',
      '@eslint-react/web-api-no-leaked-event-listener': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-var': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/globals': 'off',
      'regexp/no-super-linear-backtracking': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/no-optional-chaining-on-undeclared-variable': 'off',
      'unicorn/no-unnecessary-splice': 'off',
    },
  },
  {
    // Vitest types its asymmetric matchers (`expect.any`, `expect.objectContaining`, ...)
    // as `any`, so a matcher used as a property value in `toEqual` or
    // `toHaveBeenCalledWith` is an unsafe assignment.
    files: [`**/*.test.${SOURCE_EXTENSIONS}`],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  // Rule: core is platform-agnostic. It imports no Tauri, React, TanStack or app code.
  {
    files: [`packages/core/**/*.${SOURCE_EXTENSIONS}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@tauri-apps/*',
                '@tanstack/*',
                'react',
                'react/*',
                'react-dom',
                'react-dom/*',
              ],
              message: CORE_IMPORT_MESSAGE,
            },
            {
              group: [
                '@/*',
                '@reflect/app',
                '@reflect/app/*',
                '@reflect/desktop',
                '@reflect/desktop/*',
                '@reflect/extension',
                '**/apps/**',
              ],
              message: CORE_IMPORT_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...CORE_DYNAMIC_IMPORT_SELECTORS, ...CODE_SHAPE_SELECTORS],
    },
  },

  // Rule: no default instances and no module-level state in core. Every
  // service is built by `createCoreServices(adapters)` and holds its state in
  // its own `#` fields.
  {
    files: [`packages/core/src/**/*.${SOURCE_EXTENSIONS}`],
    ignores: [`**/*.test.${SOURCE_EXTENSIONS}`],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...CORE_DYNAMIC_IMPORT_SELECTORS,
        ...DEFAULT_INSTANCE_SELECTORS,
        ...MODULE_LET_SELECTORS,
        ...CODE_SHAPE_SELECTORS,
      ],
    },
  },
  {
    // `setTestDatabaseOpener`: the one process-wide test hook. The browser
    // projects install the wasm database once per page, before any test
    // builds its services. It is exported from `@reflect/core/testing` only.
    files: ['packages/core/src/testing/database.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...CORE_DYNAMIC_IMPORT_SELECTORS,
        ...DEFAULT_INSTANCE_SELECTORS,
        ...CODE_SHAPE_SELECTORS,
      ],
    },
  },

  // Rule: `@reflect/app` is the app layer. It knows windows, routes and commands,
  // but no React, TanStack, Tauri or app code: those stay in `apps/`.
  {
    files: [`packages/app/**/*.${SOURCE_EXTENSIONS}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@tauri-apps/*',
                '@tanstack/*',
                'react',
                'react/*',
                'react-dom',
                'react-dom/*',
                '@/*',
                '@reflect/desktop',
                '@reflect/desktop/*',
                '@reflect/extension',
                '**/apps/**',
              ],
              message: APP_IMPORT_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        dynamicImportSelector(
          String.raw`^(?:@tauri-apps\/|@tanstack\/|react(?:-dom)?(?:\/|$))`,
          APP_IMPORT_MESSAGE,
        ),
        ...CODE_SHAPE_SELECTORS,
      ],
    },
  },
  {
    files: [`packages/app/src/**/*.${SOURCE_EXTENSIONS}`],
    ignores: [`**/*.test.${SOURCE_EXTENSIONS}`],
    rules: {
      'no-restricted-syntax': [
        'error',
        dynamicImportSelector(
          String.raw`^(?:@tauri-apps\/|@tanstack\/|react(?:-dom)?(?:\/|$))`,
          APP_IMPORT_MESSAGE,
        ),
        ...DEFAULT_INSTANCE_SELECTORS,
        ...MODULE_LET_SELECTORS,
        ...CODE_SHAPE_SELECTORS,
      ],
    },
  },

  // Rule: the desktop app reaches the platform through the adapters in
  // `services/`. Everything else gets a service from `useCoreServices()` / `ctx`.
  // Also: tests use the `act` of `test-utils/act.ts`.
  {
    files: [`apps/desktop/src/**/*.${SOURCE_EXTENSIONS}`],
    ignores: ['apps/desktop/src/test-utils/act.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@tauri-apps/*'], message: TAURI_IMPORT_MESSAGE }] },
      ],
      'no-restricted-syntax': [
        'error',
        REACT_ACT_SELECTOR,
        dynamicImportSelector(String.raw`^@tauri-apps\/`, TAURI_IMPORT_MESSAGE),
        ...CODE_SHAPE_SELECTORS,
      ],
    },
  },
  {
    files: [
      // The adapters.
      `apps/desktop/src/services/**/*.${SOURCE_EXTENSIONS}`,
      // The composition roots: `boot.ts` asks Tauri whether the shell is
      // native before any service exists; `main.tsx` is listed with it and
      // imports nothing from Tauri today.
      'apps/desktop/src/boot.ts',
      'apps/desktop/src/main.tsx',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', REACT_ACT_SELECTOR, ...CODE_SHAPE_SELECTORS],
    },
  },

  // Rule: all diagnostics go through `LoggerService`, in the app and in tests.
  {
    files: [
      `apps/desktop/src/**/*.${SOURCE_EXTENSIONS}`,
      `packages/*/src/**/*.${SOURCE_EXTENSIONS}`,
    ],
    ignores: [
      // The console implementation of `LoggerService`, and its test.
      'packages/core/src/ports/logger-service.ts',
      'packages/core/src/ports/logger-service.test.ts',
      // Boot-time: the platform facts are read before any service exists
      // (they decide which services to build).
      'apps/desktop/src/services/detect-platform.ts',
      // The in-memory backend of browser dev. It stands in for the Rust side
      // of the IPC bridge and has no services.
      'apps/desktop/src/dev/**',
    ],
    rules: { 'no-restricted-globals': NO_CONSOLE },
  },

  // Rule: a test builds its services (`createTestCoreServices`, `renderInApp`)
  // and does not replace modules. `vi.mock` is for pure UI children and heavy
  // children only; `@reflect/core`, `@/lib/*` and the providers that are a
  // thin shell over a service are never on the list.
  viMockBlock([`packages/**/*.${SOURCE_EXTENSIONS}`], []),
  viMockBlock([`apps/desktop/**/*.${SOURCE_EXTENSIONS}`], DESKTOP_VI_MOCK_ALLOW),
  ...Object.entries(DESKTOP_VI_MOCK_ALLOW_BY_FILE).map(([file, allow]) =>
    viMockBlock([file], [...DESKTOP_VI_MOCK_ALLOW, ...allow]),
  ),
  viMockBlock([`apps/extension/**/*.${SOURCE_EXTENSIONS}`], EXTENSION_VI_MOCK_ALLOW),
)
