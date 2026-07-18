export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return value;
  });
}
