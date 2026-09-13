import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Source layering. Runtime imports flow one way:
// domain -> storage -> daemon -> { cli, claude, cloud, codex }.
// Ports in src/daemon/ports.ts are implemented by adapters through
// `import type`, so type-only imports may point upward where noted below.
// Test files are exempt: they compose the whole tree on purpose.
const sourceDirectories = ["claude", "cli", "cloud", "codex", "daemon", "storage"];
const compositionRoots = "(cli|index)(\\.ts)?";

const siblingDirectoryPattern = (directories) =>
  `^\\.\\./(${directories.join("|")})/`;

const forbidSiblings = (directories, message, allowTypeImports = false) => ({
  regex: siblingDirectoryPattern(directories),
  message,
  allowTypeImports,
});

const forbidCompositionRoots = {
  regex: `^\\.\\./${compositionRoots}$`,
  message: "Owned source modules must not import the CLI composition root or the package entry point.",
};

const layerRules = (patterns) => ({
  "no-restricted-imports": "off",
  "@typescript-eslint/no-restricted-imports": ["error", { patterns }],
});

// These explicitly owned fixture files sit exactly two levels below app/. Only canonical
// app-source paths qualify; dot-segment escapes still reach the core boundary.
const browserFixtureAppSource = "\\.\\./\\.\\./src/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\\.(?:stylex\\.)?(?:ts|tsx|css))?";

export default tseslint.config(
  {
    ignores: [
      "app/dist/**",
      "convex/_generated/**",
      "dist/**",
      "eslint.config.mjs",
      "node_modules/**",
      "site/dist/**",
      "tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        sourceDirectories,
        "src/domain is the leaf layer. It imports only domain modules and the root text utilities.",
      ),
      forbidCompositionRoots,
    ]),
  },
  {
    files: ["src/storage/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        ["claude", "cli", "cloud", "codex"],
        "src/storage imports domain and storage. Move shared shapes into src/domain.",
      ),
      forbidSiblings(
        ["daemon"],
        "src/storage may import only types from src/daemon (the facts-memory lifecycle seam).",
        true,
      ),
      forbidCompositionRoots,
    ]),
  },
  {
    files: ["src/daemon/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        ["claude", "cli", "cloud", "codex"],
        "src/daemon imports domain, storage, and daemon at runtime. Adapters reach it through `import type` of src/daemon/ports.ts.",
        true,
      ),
      forbidCompositionRoots,
    ]),
  },
  {
    files: ["src/cli/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        ["storage"],
        "src/cli imports domain, daemon, and cli. Provider and storage effects go through the daemon.",
      ),
      {
        regex: "^\\.\\./codex/(?!pin(\\.ts)?$)",
        message: "src/cli reaches src/codex only through the zero-import pin constants in codex/pin.ts. Provider effects go through the daemon.",
      },
      {
        regex: "^\\.\\./claude/(?!pin(\\.ts)?$)",
        message: "src/cli reaches src/claude only through the zero-import pin constants in claude/pin.ts. Provider effects go through the daemon.",
      },
      {
        regex: "^\\.\\./cloud/(?!(contracts|authCredentials)(\\.ts)?$)",
        message: "src/cli reaches src/cloud only through contracts.ts and authCredentials.ts (the rendering and parsing seam).",
      },
      forbidCompositionRoots,
    ]),
  },
  {
    files: ["src/codex/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        ["claude", "cli", "cloud", "daemon", "storage"],
        "src/codex imports codex and domain only.",
      ),
      forbidCompositionRoots,
    ]),
  },
  {
    files: ["src/claude/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        ["cli", "cloud", "codex", "daemon", "storage"],
        "src/claude imports claude and domain only.",
      ),
      forbidCompositionRoots,
    ]),
  },
  {
    files: ["src/cloud/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: layerRules([
      forbidSiblings(
        ["cli"],
        "src/cloud imports cloud, domain, storage, daemon, and codex. It never imports the CLI or provider-runtime adapters.",
      ),
      forbidCompositionRoots,
    ]),
  },
  {
    files: [
      "src/public-provider-identifier.ts",
      "src/sensitive-text.ts",
      "src/streaming-sensitive-text.ts",
      "src/version.ts",
    ],
    rules: layerRules([
      {
        regex: `^\\./(${sourceDirectories.join("|")})/`,
        message: "Root text utilities are imported by src/domain, so they import only src/domain and each other.",
      },
    ]),
  },
  {
    // The browser app is a separate consumer of the repository, not another
    // `src/` layer. It may reach only the browser-safe cloud modules and the
    // domain leaf, and it reaches those through `app/src/oompa/`. Every other
    // `src/cloud` module is node-only (daemon adapters, journals, on-disk
    // secret custody) and must never enter the bundle.
    files: ["app/**/*.ts", "app/**/*.tsx"],
    rules: layerRules([
      {
        regex: "(^|/)src/(?!cloud/(client|contracts|crypto|payloads|projection)(\\.ts)?$)(?!domain/)",
        message:
          "app/ imports repository source only from src/cloud/{crypto,projection,payloads,contracts,client} and src/domain/*, through app/src/oompa/.",
      },
    ]),
  },
  {
    files: [
      "app/fixtures/browser/io.ts", "app/fixtures/browser/main.tsx",
      "app/fixtures/product/io.ts", "app/fixtures/product/main.tsx",
      "app/fixtures/product/fixtures.ts", "app/fixtures/product/definition.test.ts",
      "app/fixtures/product/usage.ts",
    ],
    rules: layerRules([
      {
        regex: `^(?!${browserFixtureAppSource}$).*(?:^|/)src/`,
        message: "Browser fixtures import app source through canonical ../../src/ paths. Repository source must stay behind app/src/oompa/.",
      },
    ]),
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    // The immutable checker is plain JavaScript with an adjacent declaration;
    // retain syntax/rule lint while its canonical admission validates its bytes.
    files: ["scripts/**/*.mjs", "site/vendor/marketing-preset/check.mjs", "site/vendor/lantern-material/check.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
