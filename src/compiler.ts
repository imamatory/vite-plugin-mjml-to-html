// MJML template compiler used by both the build and the dev path.
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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

export interface RenderResult {
  html: string;
  warnings: string[];
}

// The part of the mjml API the plugin uses. mjml 4 returns the result, mjml 5 returns a promise.
interface MjmlResult {
  html: string;
  errors?: { formattedMessage: string }[];
}
type Mjml = (source: string, options: MjmlToHtmlMjmlOptions) => MjmlResult | Promise<MjmlResult>;

export function createCompiler({ mjmlOptions = {} }: { mjmlOptions?: MjmlToHtmlMjmlOptions } = {}) {
  let mjml: Mjml | undefined;

  /**
   * Compile one template. Returns `{ html, warnings }`; `warnings` are the formatted messages of
   * the mjml validator (empty with `validationLevel: 'strict'`, which throws instead).
   */
  const render = async (filePath: string): Promise<RenderResult> => {
    try {
      // Loading mjml takes 150–300 ms, far more than compiling: do it on first use, so commands
      // that never compile (`vite preview`, config tooling) do not pay for it.
      mjml ??= require('mjml') as Mjml;
      // `filePath` makes `mj-include` paths resolve relative to the template.
      const result = await mjml(readFileSync(filePath, 'utf8'), { filePath, ...mjmlOptions });
      return { html: result.html, warnings: (result.errors ?? []).map((error) => error.formattedMessage) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`mjml-to-html: failed to compile ${filePath}\n${message}`, { cause: error });
    }
  };

  return { render };
}
