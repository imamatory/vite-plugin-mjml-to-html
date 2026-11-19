// Type-checked against the built package by `pnpm typecheck`; never executed.
import type { Plugin, UserConfig } from 'vite';
import mjmlToHtmlPlugin from 'vite-plugin-mjml-to-html';

const plugin: Plugin = mjmlToHtmlPlugin({
  input: { mail_templates: ['/abs/src/mails/*.mjml'] },
  dest: '/abs/dist',
  mjmlOptions: { keepComments: false, validationLevel: 'strict' },
});

export const config: UserConfig = { plugins: [plugin] };

// @ts-expect-error `dest` is required
mjmlToHtmlPlugin({ input: {} });
// @ts-expect-error unknown validation level
mjmlToHtmlPlugin({ input: {}, dest: 'dist', mjmlOptions: { validationLevel: 'loose' } });
