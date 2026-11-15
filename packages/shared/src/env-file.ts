export const ENV_UPLOAD_LIMIT = 128 * 1024;

/** Strict upload parser: report line numbers without echoing secret values. No shell expansion or execution. */
export function parseEnvUpload(content: string): Record<string, string> {
  if (new TextEncoder().encode(content).length > ENV_UPLOAD_LIMIT) throw new Error("Choose an .env file smaller than 128 KB.");
  if (content.includes("\0")) throw new Error("Choose a UTF-8 text .env file.");
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const values: Record<string, string> = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const at = i + 1;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,127})\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env assignment on line ${at}. Use NAME=value.`);
    const name = match[1]!;
    let value = match[2]!;
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let end = -1;
      for (let pos = 1; ; pos++) {
        if (pos >= value.length) {
          if (++i >= lines.length) throw new Error(`Unclosed quote in .env on line ${at}.`);
          value += "\n" + lines[i]!;
        }
        if (value[pos] === quote) {
          let slashes = 0;
          for (let k = pos - 1; k >= 0 && value[k] === "\\"; k--) slashes++;
          if (slashes % 2 === 0) { end = pos; break; }
        }
      }
      const tail = value.slice(end + 1).trim();
      if (tail && !tail.startsWith("#")) throw new Error(`Unexpected text after the value on .env line ${at}.`);
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\([nr"\\])/g, (_match, char: string) => ({ n: "\n", r: "\r", '"': '"', "\\": "\\" })[char]!);
    } else value = value.split("#")[0]!.trim();
    if (value.length > 16_384) throw new Error(`The setting on .env line ${at} is too large (maximum 16 KB).`);
    values[name] = value;
    if (Object.keys(values).length > 500) throw new Error("An .env upload may contain at most 500 settings.");
  }
  if (!Object.keys(values).length) throw new Error("This .env file contains no settings.");
  return values;
}
