# vite-plugin-mjml-to-html

A Vite plugin that compiles [MJML](https://mjml.io) email templates into static html files. The files are written
next to the bundle and consumed by something else, for example a backend that sends them as emails.

- Templates are compiled while the bundler works and written after it, so they add almost nothing to `vite build`.
- `mjml` is loaded on first use: commands that never compile (`vite preview`, config tooling) do not pay for it.
- In dev every `.mjml` change recompiles the templates and reloads the browser. A broken template does not stop the
  dev server.
- Works with mjml 4 and mjml 5.

## Install

```sh
npm install --save-dev vite-plugin-mjml-to-html mjml
```

Requires Node 20.19+ or 22.12+, Vite 5 or newer and mjml 4.18+ or 5.

## Usage

```js
// vite.config.js
import path from 'node:path';
import mjmlToHtml from 'vite-plugin-mjml-to-html';

export default {
  plugins: [
    mjmlToHtml({
      input: { mails: [path.resolve('src/mails/*.mjml')] },
      dest: path.resolve('dist/templates'),
      mjmlOptions: { keepComments: false },
    }),
  ],
};
```

Every file matched by `input[subfolder]` becomes `<dest>/<subfolder>/<basename>.html`. Files that are only used
through `mj-include` must not match the globs.

## Options

| Option        | Type                              | Default  | Description                                                            |
| ------------- | --------------------------------- | -------- | ---------------------------------------------------------------------- |
| `input`       | `{ [subfolder]: glob \| glob[] }` | required | Templates to compile, grouped by output subfolder (fast-glob)          |
| `dest`        | `string`                          | required | Output directory                                                       |
| `mjmlOptions` | `object`                          | `{}`     | Passed to mjml as is: `keepComments`, `validationLevel`, `fonts`, …    |

Invalid options throw when the plugin is created, not during the build.

The plugin sets one mjml option itself: `filePath`, the path of the template. It makes `mj-include` paths resolve
relative to the template instead of the working directory. `mjmlOptions.filePath` overrides it.

## `mj-include` in mjml 5

mjml 5 changed the defaults, and an include that is not allowed is dropped **without an error or a warning**:

- `ignoreIncludes` is `true` by default: every `mj-include` is ignored.
- With `ignoreIncludes: false`, only files under the template's own directory are included. Files elsewhere (for
  example `../partials/footer.mjml`) need their directory in `includePath`.

```js
mjmlToHtml({
  input: { mails: path.resolve('src/mails/*.mjml') },
  dest: path.resolve('dist/templates'),
  mjmlOptions: { ignoreIncludes: false, includePath: [path.resolve('src/partials')] },
});
```

mjml 4 includes by default and ignores `includePath`, so the same options work with both versions.

## Build

1. `buildStart` schedules the compilation for the next turn of the event loop and returns at once.
2. The templates are compiled into memory while the bundler works.
3. `closeBundle` writes the html files and logs them with their sizes.

Details:

- The files are written in `closeBundle` and not earlier, because `vite:prepare-out-dir` empties `outDir` in
  `renderStart`, which runs after `buildStart`.
- If the bundle fails, nothing is written and the bundle error is the one reported.
- Every template is compiled on every build. There is no cache.
- Output goes through Vite's logger, so `logLevel: 'warn'` or `--logLevel silent` hides the file list.

## Dev

- `configureServer` compiles every template before the server starts.
- The directories of the templates are watched for `**/*.mjml`. Any added, changed or removed `.mjml` file
  recompiles every template and triggers a full page reload.
- A broken template does not stop the dev server. The error is logged and shown in the Vite error overlay.
- A template that is broken when the dev server starts fails the start.

## Errors and validation

MJML has two kinds of problems, and `mjmlOptions.validationLevel` decides what happens to the first:

- **Validation problems** (unknown element, illegal attribute). With the default level `soft` the html is still
  written and each problem is logged as a warning with the template path. With `strict` the build fails. With
  `skip` nothing is checked.
- **Exceptions** (malformed markup, a missing `mj-include` in strict mode). The build fails.

A failure names the template:

```text
mjml-to-html: failed to compile /abs/src/mails/broken.mjml
ValidationError: ...
```

Use `validationLevel: 'strict'` in CI if a broken email must not be shipped.

## Design: no workers, no cache

A template compiles in 1–2 ms, so the plugin uses neither worker threads nor a cache. Measured with 6 templates,
mjml 4.18, Node 22, Apple Silicon:

| What                       | Time       |
| -------------------------- | ---------- |
| Loading the `mjml` package | 130–270 ms |
| Compiling all 6 templates  | 8 ms       |
| Starting one worker thread | ~100 ms    |

A worker would have to load mjml again and costs more than it saves until there are hundreds of templates. Checking
a cache would cost about as much as compiling.

What is slow is loading mjml, so that is what the plugin moves out of the way:

| What                          | Eager load | This plugin |
| ----------------------------- | ---------- | ----------- |
| Import of the plugin module   | 135 ms     | 13 ms       |
| `buildStart`                  | 16 ms      | <1 ms       |
| `closeBundle`                 | 20 ms      | 3 ms        |
| Total on top of the bundle    | 170 ms     | 18 ms       |

## Safety

- An `input` key that would place a file outside `dest` (for example `../x`) throws.
- Two templates with the same basename in one subfolder write the same html file. The last one wins and a warning is
  logged once.
- `mj-include` can read files the build process can read. Compile trusted templates only.

## Limitations

- Files used through `mj-include` are watched in dev only if they lie under the directory of a template.
- Removing a template in dev does not remove its html from `dest`.

## Development

```sh
pnpm install
pnpm check   # build, types, tests, package contents
```

## License

[MIT](LICENSE)
