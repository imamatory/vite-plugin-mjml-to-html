import type { Plugin } from 'vite';

/** Options passed to mjml as is. The plugin sets `filePath` to the template path unless given here. */
export interface MjmlToHtmlMjmlOptions {
  keepComments?: boolean;
  validationLevel?: 'strict' | 'soft' | 'skip';
  fonts?: Record<string, string>;
  minify?: boolean;
  beautify?: boolean;
  ignoreIncludes?: boolean;
  filePath?: string;
  [option: string]: unknown;
}

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

export default function mjmlToHtmlPlugin(options: MjmlToHtmlOptions): Plugin;
