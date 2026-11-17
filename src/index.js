// Vite plugin: compiles MJML email templates to html files in `dest`.
//
// Options:
// - `input`: `{ [subfolder]: glob | glob[] }`. Every matched file becomes
//   `<dest>/<subfolder>/<name>.html`.
// - `dest`: output directory.
// - `mjmlOptions`: options passed to mjml (`keepComments`, `validationLevel`, `fonts`, …).
//
// Build: templates are compiled once, in memory, right after `buildStart`, while the bundler
// works. They are written in `closeBundle`, not earlier: `vite:prepare-out-dir` empties `outDir`
// in `renderStart`, after `buildStart`.
// Dev: every template is recompiled when a `.mjml` file changes.
//
// There are no worker threads and no cache on purpose: a template compiles in 1–2 ms, less than
// a worker needs to start. See README.md for the numbers.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { createCompiler } from './compiler.js';

const require = createRequire(import.meta.url);
const { globSync } = require('fast-glob');
const pc = require('picocolors');

// Used until `configResolved` provides Vite's logger, e.g. when the hooks are called directly.
const consoleLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export default function mjmlToHtmlPlugin({ input, dest, mjmlOptions = {} } = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error(`mjml-to-html: "input" must be an object, got ${typeof input}`);
  }
  if (!dest) {
    throw new Error('mjml-to-html: "dest" is required');
  }
  if (!mjmlOptions || typeof mjmlOptions !== 'object') {
    throw new Error(`mjml-to-html: "mjmlOptions" must be an object, got ${typeof mjmlOptions}`);
  }

  const destRoot = path.resolve(dest);
  const compiler = createCompiler({ mjmlOptions });
  const writtenFiles = [];
  // html paths written by two templates, already reported: warn once, not on every dev recompile.
  const reportedCollisions = new Set();
  let isBuild = false;
  let logger = consoleLogger;
  let buildJob = null;

  const formatSize = (bytes) => {
    const kb = bytes / 1024;
    if (kb >= 1024) {
      return `${(kb / 1024).toFixed(2)} MB`;
    }
    if (kb >= 1) {
      return `${kb.toFixed(2)} kB`;
    }
    return `${bytes} B`;
  };

  const colorBySize = (str, bytes) => {
    if (bytes < 10240) return pc.green(str);
    if (bytes < 102400) return pc.yellow(str);
    return pc.red(str);
  };

  const logBuildOutput = (duration) => {
    if (writtenFiles.length === 0) return;

    const maxLen = Math.max(...writtenFiles.map((f) => path.basename(f).length));
    const pad = maxLen + 4;

    logger.info('');
    writtenFiles.forEach((outPath) => {
      if (!existsSync(outPath)) return;
      const { size } = statSync(outPath);
      const sizeStr = formatSize(size);
      const dir = pc.dim(`${path.dirname(outPath)}/`);
      const name = path.basename(outPath);
      logger.info(
        `${dir}${colorBySize(name, size)}${' '.repeat(pad - name.length)}${pc.bold(colorBySize(sizeStr, size))}`,
      );
    });
    logger.info(`  ${pc.dim(`${writtenFiles.length} files, ${(duration / 1000).toFixed(2)}s`)}`);
  };

  const collectTemplates = () => {
    const templates = [];
    const owners = new Map();

    Object.entries(input).forEach(([subfolder, patterns]) => {
      globSync(patterns).forEach((filePath) => {
        const htmlPath = path.resolve(destRoot, subfolder, `${path.basename(filePath, '.mjml')}.html`);
        if (!htmlPath.startsWith(destRoot + path.sep)) {
          throw new Error(`mjml-to-html: output of ${filePath} is outside "dest": ${htmlPath}`);
        }
        const owner = owners.get(htmlPath);
        if (owner !== undefined && owner !== filePath && !reportedCollisions.has(htmlPath)) {
          reportedCollisions.add(htmlPath);
          logger.warn(pc.yellow(`mjml-to-html: ${owner} and ${filePath} both write ${htmlPath}; the last one wins`));
        }
        owners.set(htmlPath, filePath);
        templates.push({ filePath, htmlPath });
      });
    });

    return templates;
  };

  const compile = async () => {
    const results = [];

    for (const { filePath, htmlPath } of collectTemplates()) {
      const { html, warnings } = await compiler.render(filePath);
      warnings.forEach((warning) => logger.warn(pc.yellow(`mjml-to-html: ${filePath}: ${warning}`)));
      results.push({ htmlPath, html });
    }

    return results;
  };

  const write = (results) => {
    writtenFiles.length = 0;

    results.forEach(({ htmlPath, html }) => {
      mkdirSync(path.dirname(htmlPath), { recursive: true });
      writeFileSync(htmlPath, html);
      writtenFiles.push(htmlPath);
    });
  };

  const compileAll = async () => write(await compile());

  // Build: start compiling on the next turn of the event loop, so `buildStart` returns at once.
  // Loading mjml and compiling then overlap with the bundler instead of running after it.
  const startBuildJob = () => {
    const nextTurn = new Promise((resolve) => {
      setImmediate(resolve);
    });
    const job = { failed: false, promise: nextTurn.then(compile) };
    // The rejection is reported from `closeBundle`; do not let it become an unhandled rejection.
    job.promise.catch(() => {});
    return job;
  };

  const refreshOnMjmlChange = async (server, file) => {
    if (!file.endsWith('.mjml')) return;
    try {
      await compileAll();
      server.ws.send({ type: 'full-reload' });
    } catch (error) {
      // A broken template must not take the dev server down: report it and wait for the fix.
      server.config.logger.error(pc.red(error.message), { error });
      server.ws.send({ type: 'error', err: { message: error.message, stack: error.stack ?? '' } });
    }
  };

  return {
    name: 'mjml-to-html',
    configResolved(config) {
      isBuild = config.command === 'build';
      logger = config.logger ?? consoleLogger;
    },
    buildStart() {
      if (isBuild) buildJob = startBuildJob();
    },
    buildEnd(error) {
      if (error && buildJob) buildJob.failed = true;
    },
    async closeBundle() {
      if (!isBuild) return;
      const job = buildJob ?? startBuildJob();
      buildJob = null;
      // The bundle failed: that error is the one to report, write nothing.
      if (job.failed) return;

      const start = performance.now();
      write(await job.promise);
      logBuildOutput(performance.now() - start);
    },
    async configureServer(server) {
      await compileAll();

      const watchedDirs = new Set(collectTemplates().map(({ filePath }) => path.dirname(filePath)));
      watchedDirs.forEach((dir) => server.watcher.add(`${dir}/**/*.mjml`));

      server.watcher.on('add', (file) => refreshOnMjmlChange(server, file));
      server.watcher.on('change', (file) => refreshOnMjmlChange(server, file));
      server.watcher.on('unlink', (file) => refreshOnMjmlChange(server, file));
    },
  };
}
