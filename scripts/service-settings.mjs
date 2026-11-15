/** Read only the generated WinSW settings needed to preserve an existing installation. */
export function readServiceSettings(xml) {
  const decode = (value) => value.replace(/&(quot|apos|lt|gt|amp);/g, (_, key) => ({ quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" })[key]);
  const values = {};
  for (const tag of xml.match(/<env\s+[^>]*\/?>/g) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
    if (attrs.name) values[attrs.name] = attrs.value;
  }
  const port = Number(values.NEXUS_PORT);
  if (!values.NEXUS_HOME || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Existing Nexus service settings are invalid. Refusing to replace the data location or port with defaults.");
  }
  return { home: values.NEXUS_HOME, port };
}
