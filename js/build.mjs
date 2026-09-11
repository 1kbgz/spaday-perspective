import { bundle } from "./tools/bundle.mjs";
import { bundle_css } from "./tools/css.mjs";
import { node_modules_external } from "./tools/externals.mjs";

import fs from "fs";
import path from "path";
import cpy from "cpy";

// The version actually bundled, read from the resolved dependency rather than the declared range,
// so a page holding a second copy of Perspective can compare and refuse rather than half-work.
const PERSPECTIVE_VERSION = JSON.parse(
  fs.readFileSync("node_modules/@perspective-dev/client/package.json", "utf8"),
).version;

// Perspective's own CDN builds: plain ESM with their dependencies inlined, each finding its engine
// binary relative to its own URL. They are served as-is, laid out as in node_modules so those
// relative lookups hold, and published under Perspective's bare specifiers (`imports` in
// spaday_perspective/__init__.py): a library on the page that imports Perspective gets this copy
// instead of registering the same custom elements a second time. The bundle imports them the same way.
const VENDORED = {
  client: ["dist/cdn/*.js"],
  server: ["dist/wasm/*.wasm"],
  viewer: ["dist/cdn/*.js", "dist/wasm/perspective-viewer.wasm"],
  "viewer-datagrid": ["dist/cdn/*.js"],
  "viewer-charts": ["dist/cdn/*.js"],
};

// The guard is a module of its own, imported first: the Perspective imports stay imports, and every
// import evaluates before the importing module's body, so an inlined guard would install too late.
// Only the JS entry points are kept -- the theme stylesheets are still inlined as text.
const keepImports = {
  name: "keep-imports",
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(@perspective-dev\/(client|viewer|viewer-datagrid|viewer-charts)|\.\/define-guard\.js)$/,
      },
      (args) => ({ path: args.path, external: true }),
    );
  },
};

const BUNDLES = [
  {
    entryPoints: ["src/ts/index.ts"],
    plugins: [node_modules_external()],
    outfile: "dist/esm/index.js",
    define: { __PERSPECTIVE_VERSION__: JSON.stringify(PERSPECTIVE_VERSION) },
  },
  {
    entryPoints: ["src/ts/define-guard.ts"],
    outfile: "dist/cdn/define-guard.js",
  },
  {
    entryPoints: ["src/ts/index.ts"],
    plugins: [keepImports],
    outfile: "dist/cdn/index.js",
    define: { __PERSPECTIVE_VERSION__: JSON.stringify(PERSPECTIVE_VERSION) },
  },
];

async function build() {
  fs.rmSync("dist", { recursive: true, force: true });
  fs.rmSync("../spaday_perspective/extension", {
    recursive: true,
    force: true,
  });

  // Bundle css
  await bundle_css();

  // Copy HTML
  await cpy("src/html/*", "dist/");

  // Copy images
  if (fs.existsSync("src/img")) {
    fs.mkdirSync("dist/img", { recursive: true });
    await cpy("src/img/*", "dist/img");
  }

  await Promise.all(BUNDLES.map(bundle)).catch(() => process.exit(1));

  for (const [name, files] of Object.entries(VENDORED)) {
    await cpy(files, path.resolve(`dist/vendor/@perspective-dev/${name}`), {
      cwd: `node_modules/@perspective-dev/${name}`,
      base: "cwd",
    });
  }

  // the exact version of every library this package serves, read by the Python package as its
  // ComponentPackage.provides, so spaday can reconcile it with the other packages on a page
  const { dependencies = {} } = JSON.parse(
    fs.readFileSync("package.json", "utf8"),
  );
  const served = Object.fromEntries(
    Object.keys(dependencies).map((name) => [
      name,
      JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8"))
        .version,
    ]),
  );
  fs.writeFileSync(
    "dist/versions.json",
    `${JSON.stringify(served, null, 2)}\n`,
  );

  // Copy servable assets to python extension (exclude esm/)
  fs.mkdirSync("../spaday_perspective/extension", { recursive: true });
  await cpy("dist/**/*", "../spaday_perspective/extension", {
    filter: (file) =>
      !file.relativePath.startsWith("esm/") &&
      !file.relativePath.startsWith("dist/esm/"),
  });
}

await build();
