// Run: npm test
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import mjmlToHtmlPlugin from '../src/index.js';

const mjml = createRequire(import.meta.url)('mjml');

let root;
let src;
let dest;
let logs;

const logger = {
  info: (message) => logs.info.push(message),
  warn: (message) => logs.warn.push(message),
  error: (message) => logs.error.push(message),
};

const write = (name, content) => {
  const file = path.join(src, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const template = (body) => `<mjml><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>\n`;

const writeTemplates = () => {
  write('partials/footer.mjml', '<mj-text>footer</mj-text>\n');
  write('mails/welcome.mjml', template('<mj-text>Welcome</mj-text><mj-include path="../partials/footer.mjml" />'));
  write('mails/reset.mjml', template('<mj-button href="https://example.com">Reset</mj-button>'));
};

const createPlugin = (options = {}, command = 'build') => {
  const plugin = mjmlToHtmlPlugin({
    input: { mails: path.join(src, 'mails/*.mjml') },
    dest,
    ...options,
  });
  plugin.configResolved({ command, logger });
  return plugin;
};

// The hooks in the order Vite calls them; `vite:prepare-out-dir` empties `dest` in between.
const runBuild = async (plugin) => {
  plugin.buildStart();
  rmSync(dest, { recursive: true, force: true });
  plugin.buildEnd();
  await plugin.closeBundle();
};

const createServer = () => {
  const handlers = {};
  const sent = [];
  const watched = [];
  const server = {
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
  assert.equal(logs.warn.length, 1);
  assert.ok(logs.warn[0].includes(file), logs.warn[0]);
});

test('validation problems fail the build with the strict level and name the template', async () => {
  const file = write('mails/invalid.mjml', template('<mj-text foo="bar">x</mj-text>'));

  await assert.rejects(runBuild(createPlugin({ mjmlOptions: { validationLevel: 'strict' } })), (error) => {
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
  assert.throws(() => mjmlToHtmlPlugin({ dest: '/tmp/x' }), /"input"/);
  assert.throws(() => mjmlToHtmlPlugin({ input: {} }), /"dest"/);
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

  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /both write .*reset\.html/);
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
  await handlers.change(path.join(src, 'notes.txt'));
  assert.deepEqual(sent, []);

  const source = write('mails/welcome.mjml', template('<mj-text>Changed</mj-text>'));
  await handlers.change(source);
  assert.match(readFileSync(welcome, 'utf8'), /Changed/);
  assert.deepEqual(sent, [{ type: 'full-reload' }]);

  // A broken template is reported to the client and does not throw.
  const strict = createPlugin({ mjmlOptions: { validationLevel: 'strict' } }, 'serve');
  const strictServer = createServer();
  await strict.configureServer(strictServer.server);
  write('mails/welcome.mjml', template('<mj-text foo="bar">x</mj-text>'));
  await strictServer.handlers.change(source);
  assert.equal(strictServer.sent[0].type, 'error');
  assert.ok(strictServer.sent[0].err.message.includes(source));
  assert.equal(logs.error.length, 1);
});
