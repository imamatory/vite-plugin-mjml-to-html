// Run: pnpm test
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import mjmlToHtmlPlugin, { type MjmlToHtmlOptions } from '../src/index.js';

type Mjml = (source: string, options: object) => Promise<{ html: string }>;
const mjml = createRequire(import.meta.url)('mjml') as Mjml;

interface Message {
  type: string;
  err?: { message: string };
}

interface FakeServer {
  watcher: {
    add: (glob: string) => void;
    on: (event: string, handler: (file: string) => Promise<void>) => void;
  };
  ws: { send: (message: Message) => void };
  config: { logger: typeof logger };
}

// The hooks as the tests call them: directly, with only the parts of Vite the plugin reads.
interface PluginHooks {
  configResolved(config: { command: string; logger: typeof logger }): void;
  buildStart(): void;
  buildEnd(error?: Error): void;
  closeBundle(): Promise<void>;
  configureServer(server: FakeServer): Promise<void>;
}

let root: string;
let src: string;
let dest: string;
let logs: { info: string[]; warn: string[]; error: string[] };

const logger = {
  info: (message: string) => logs.info.push(message),
  warn: (message: string) => logs.warn.push(message),
  error: (message: string) => logs.error.push(message),
};

const write = (name: string, content: string) => {
  const file = path.join(src, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const template = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>\n`;

const writeTemplates = () => {
  write('partials/footer.mjml', '<mj-text>footer</mj-text>\n');
  write('mails/welcome.mjml', template('<mj-text>Welcome</mj-text><mj-include path="../partials/footer.mjml" />'));
  write('mails/reset.mjml', template('<mj-button href="https://example.com">Reset</mj-button>'));
};

const createPlugin = (options: Partial<MjmlToHtmlOptions> = {}, command = 'build') => {
  const plugin = mjmlToHtmlPlugin({
    input: { mails: path.join(src, 'mails/*.mjml') },
    dest,
    ...options,
  }) as unknown as PluginHooks;
  plugin.configResolved({ command, logger });
  return plugin;
};

// The hooks in the order Vite calls them; `vite:prepare-out-dir` empties `dest` in between.
const runBuild = async (plugin: PluginHooks) => {
  plugin.buildStart();
  rmSync(dest, { recursive: true, force: true });
  plugin.buildEnd();
  await plugin.closeBundle();
};

type Handlers = Record<string, (file: string) => Promise<void>>;

const handler = (handlers: Handlers, event: string) => {
  const fn = handlers[event];
  if (!fn) throw new Error(`no ${event} handler registered`);
  return fn;
};

const createServer = () => {
  const handlers: Handlers = {};
  const sent: Message[] = [];
  const watched: string[] = [];
  const server: FakeServer = {
    watcher: {
      add: (glob) => watched.push(glob),
      on: (event, handler) => Object.assign(handlers, { [event]: handler }),
    },
    ws: { send: (message) => sent.push(message) },
    config: { logger },
  };
  return { server, handlers, sent, watched };
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'mjml-to-html-'));
  src = path.join(root, 'src');
  dest = path.join(root, 'dist');
  logs = { info: [], warn: [], error: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// mjml 5 ignores `mj-include` by default, and includes outside the template folder need `includePath`.
// mjml 4 includes by default and ignores `includePath`.
const includeOptions = () => ({ ignoreIncludes: false, includePath: path.join(src, 'partials') });

// CI points `mjml` at one major per matrix leg (see ci.yml): fail rather than test the other one.
test('mjml is the major CI asks for', { skip: !process.env.MJML_MAJOR }, () => {
  const { version } = createRequire(import.meta.url)('mjml/package.json') as { version: string };
  assert.equal(version.split('.')[0], process.env.MJML_MAJOR);
});

test('build output equals mjml and resolves mj-include relative to the template', async () => {
  writeTemplates();

  await runBuild(createPlugin({ mjmlOptions: includeOptions() }));

  for (const name of ['welcome', 'reset']) {
    const filePath = path.join(src, `mails/${name}.mjml`);
    const expected = (await mjml(readFileSync(filePath, 'utf8'), { filePath, ...includeOptions() })).html;
    assert.equal(readFileSync(path.join(dest, `mails/${name}.html`), 'utf8'), expected);
  }
  assert.match(readFileSync(path.join(dest, 'mails/welcome.html'), 'utf8'), /footer/);
  assert.match(logs.info.join('\n'), /2 files/);
});

test('mjmlOptions are passed to mjml', async () => {
  write('mails/comment.mjml', template('<!-- keep me --><mj-text>x</mj-text>'));

  await runBuild(createPlugin());
  assert.match(readFileSync(path.join(dest, 'mails/comment.html'), 'utf8'), /keep me/);

  await runBuild(createPlugin({ mjmlOptions: { keepComments: false } }));
  assert.doesNotMatch(readFileSync(path.join(dest, 'mails/comment.html'), 'utf8'), /keep me/);
});

test('validation problems are warnings with the soft level', async () => {
  const file = write('mails/invalid.mjml', template('<mj-text foo="bar">x</mj-text>'));

  await runBuild(createPlugin());

  assert.ok(existsSync(path.join(dest, 'mails/invalid.html')));
  const [warning = ''] = logs.warn;
  assert.equal(logs.warn.length, 1);
  assert.ok(warning.includes(file), warning);
});

test('validation problems fail the build with the strict level and name the template', async () => {
  const file = write('mails/invalid.mjml', template('<mj-text foo="bar">x</mj-text>'));

  await assert.rejects(runBuild(createPlugin({ mjmlOptions: { validationLevel: 'strict' } })), (error: Error) => {
    assert.match(error.message, /mjml-to-html: failed to compile/);
    assert.ok(error.message.includes(file));
    return true;
  });
  assert.equal(existsSync(path.join(dest, 'mails/invalid.html')), false);
});

test('a failed bundle writes nothing and does not report the mjml error', async () => {
  write('mails/invalid.mjml', template('<mj-text foo="bar">x</mj-text>'));
  const plugin = createPlugin({ mjmlOptions: { validationLevel: 'strict' } });

  plugin.buildStart();
  plugin.buildEnd(new Error('bundle failed'));
  await plugin.closeBundle();

  assert.equal(existsSync(dest), false);
});

test('rejects invalid options', () => {
  // @ts-expect-error `input` is missing
  assert.throws(() => mjmlToHtmlPlugin({ dest: '/tmp/x' }), /"input"/);
  // @ts-expect-error `dest` is missing
  assert.throws(() => mjmlToHtmlPlugin({ input: {} }), /"dest"/);
  // @ts-expect-error `mjmlOptions` is null
  assert.throws(() => mjmlToHtmlPlugin({ input: {}, dest: '/tmp/x', mjmlOptions: null }), /"mjmlOptions"/);
});

test('an input key cannot write outside dest', async () => {
  writeTemplates();
  const plugin = createPlugin({ input: { '../outside': path.join(src, 'mails/*.mjml') } });

  await assert.rejects(runBuild(plugin), /outside "dest"/);
});

test('two templates that write the same html file are reported once', async () => {
  writeTemplates();
  write('other/reset.mjml', template('<mj-text>other</mj-text>'));
  const plugin = createPlugin({
    input: { mails: [path.join(src, 'mails/*.mjml'), path.join(src, 'other/*.mjml')] },
  });

  await runBuild(plugin);
  await runBuild(plugin);

  const [warning = ''] = logs.warn;
  assert.equal(logs.warn.length, 1);
  assert.match(warning, /both write .*reset\.html/);
});

test('dev compiles on start, recompiles on change and reports a broken template', async () => {
  writeTemplates();
  const plugin = createPlugin({}, 'serve');
  const { server, handlers, sent, watched } = createServer();

  await plugin.configureServer(server);
  const welcome = path.join(dest, 'mails/welcome.html');
  assert.match(readFileSync(welcome, 'utf8'), /Welcome/);
  assert.deepEqual(watched, [`${path.join(src, 'mails')}/**/*.mjml`]);

  // Files other than .mjml are ignored.
  await handler(handlers, 'change')(path.join(src, 'notes.txt'));
  assert.deepEqual(sent, []);

  const source = write('mails/welcome.mjml', template('<mj-text>Changed</mj-text>'));
  await handler(handlers, 'change')(source);
  assert.match(readFileSync(welcome, 'utf8'), /Changed/);
  assert.deepEqual(sent, [{ type: 'full-reload' }]);

  // A broken template is reported to the client and does not throw.
  const strict = createPlugin({ mjmlOptions: { validationLevel: 'strict' } }, 'serve');
  const strictServer = createServer();
  await strict.configureServer(strictServer.server);
  write('mails/welcome.mjml', template('<mj-text foo="bar">x</mj-text>'));
  await handler(strictServer.handlers, 'change')(source);
  const [message] = strictServer.sent;
  assert.equal(message?.type, 'error');
  assert.ok(message.err?.message.includes(source));
  assert.equal(logs.error.length, 1);
});
