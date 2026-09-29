/** Minimal `{{name}}` substitution. Unknown names throw, so a prompt typo fails in tests, not in a job. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt template variable "${name}" is not provided`);
    return v;
  });
}
