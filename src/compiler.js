// MJML template compiler used by both the build and the dev path.
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function createCompiler({ mjmlOptions = {} } = {}) {
  let mjml;

  /**
   * Compile one template. Returns `{ html, warnings }`; `warnings` are the formatted messages of
   * the mjml validator (empty with `validationLevel: 'strict'`, which throws instead).
   */
  const render = async (filePath) => {
    try {
      // Loading mjml takes 150–300 ms, far more than compiling: do it on first use, so commands
      // that never compile (`vite preview`, config tooling) do not pay for it.
      mjml ??= require('mjml');
      // `filePath` makes `mj-include` paths resolve relative to the template.
      // mjml 4 returns the result, mjml 5 returns a promise.
      const result = await mjml(readFileSync(filePath, 'utf8'), { filePath, ...mjmlOptions });
      return { html: result.html, warnings: (result.errors ?? []).map((error) => error.formattedMessage) };
    } catch (error) {
      throw new Error(`mjml-to-html: failed to compile ${filePath}\n${error?.message ?? error}`, { cause: error });
    }
  };

  return { render };
}
