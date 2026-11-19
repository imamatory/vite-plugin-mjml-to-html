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
import fg from 'fast-glob';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import pc from 'picocolors';
import type { Logger, Plugin, ViteDevServer } from 'vite';
import { createCompiler, type MjmlToHtmlMjmlOptions } from './compiler.js';

export type { MjmlToHtmlMjmlOptions } from './compiler.js';

export interface MjmlToHtmlOptions {
  /**
   * Templates to compile, grouped by output subfolder: `{ [subfolder]: glob | glob[] }` (fast-glob
   * patterns). Every matched file becomes `<dest>/<subfolder>/<basename>.html`.
   */
  input: Record<string, string | string[]>;
  /** Output directory. */
  dest: string;
  mjmlOptions?: MjmlToHtmlMjmlOptions;
}

type PluginLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

interface Template {
  filePath: string;
  htmlPath: string;
}

interface CompiledTemplate {
  htmlPath: string;
  html: string;
}

interface BuildJob {
  failed: boolean;
  promise: Promise<CompiledTemplate[]>;
}

// Used until `configResolved` provides Vite's logger, e.g. when the hooks are called directly.
const consoleLogger: PluginLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export default function mjmlToHtmlPlugin(options: MjmlToHtmlOptions): Plugin {
  // Checked at runtime too: JavaScript configs get no type checking.
  const { input, dest, mjmlOptions = {} } = options ?? ({} as Partial<MjmlToHtmlOptions>);
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
  const writtenFiles: string[] = [];
  // html paths written by two templates, already reported: warn once, not on every dev recompile.
  const reportedCollisions = new Set<string>();
  let isBuild = false;
  let logger = consoleLogger;
  let buildJob: BuildJob | null = null;

  const formatSize = (bytes: number) => {
    const kb = bytes / 1024;
    if (kb >= 1024) {
      return `${(kb / 1024).toFixed(2)} MB`;
    }
    if (kb >= 1) {
      return `${kb.toFixed(2)} kB`;
    }
    return `${bytes} B`;
  };

  const colorBySize = (str: string, bytes: number) => {
    if (bytes < 10240) return pc.green(str);
    if (bytes < 102400) return pc.yellow(str);
    return pc.red(str);
  };

  const logBuildOutput = (duration: number) => {
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

  const collectTemplates = (): Template[] => {
    const templates: Template[] = [];
    const owners = new Map<string, string>();

    Object.entries(input).forEach(([subfolder, patterns]) => {
      fg.globSync(patterns).forEach((filePath) => {
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

  const compile = async (): Promise<CompiledTemplate[]> => {
    const results: CompiledTemplate[] = [];

    for (const { filePath, htmlPath } of collectTemplates()) {
      const { html, warnings } = await compiler.render(filePath);
      warnings.forEach((warning) => logger.warn(pc.yellow(`mjml-to-html: ${filePath}: ${warning}`)));
      results.push({ htmlPath, html });
    }

    return results;
  };

  const write = (results: CompiledTemplate[]) => {
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
  const startBuildJob = (): BuildJob => {
    const nextTurn = new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const job: BuildJob = { failed: false, promise: nextTurn.then(compile) };
    // The rejection is reported from `closeBundle`; do not let it become an unhandled rejection.
    job.promise.catch(() => {});
    return job;
  };

  const refreshOnMjmlChange = async (server: ViteDevServer, file: string) => {
    if (!file.endsWith('.mjml')) return;
    try {
      await compileAll();
      server.ws.send({ type: 'full-reload' });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
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
