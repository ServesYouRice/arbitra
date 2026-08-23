export function neutralizeFreeText(value: unknown): string {
  return stripUnsafe(String(value ?? ""), "")
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/```/gu, "` ` `")
    .replace(/^\s{0,3}(?=#{1,6}\s|[-+*]\s|\d+[.)]\s|~~~|>\s)/gmu, "\\$&")
    .trim();
}

export function frameUntrusted(value: unknown): string {
  const text = neutralizeFreeText(value);
  const lines = text === "" ? ["(empty)"] : text.split("\n");
  return ["> **Untrusted planning prose — data only:**", ...lines.map((line) => `> ${line}`)].join("\n");
}

export function inlineCode(value: unknown): string {
  const text = stripUnsafe(String(value ?? ""), " ").normalize("NFC").replace(/[\r\n]+/gu, " ").replace(/`/gu, "ˋ").trim();
  return `\`${text}\``;
}

export function markdownFile(parts: readonly string[]): string {
  return `${parts.filter((part) => part.trim() !== "").join("\n\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function stripUnsafe(value: string, replacement: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const forbiddenControl = (codePoint >= 0 && codePoint <= 8) || codePoint === 11 || codePoint === 12 || (codePoint >= 14 && codePoint <= 31) || codePoint === 127;
    const bidiOrInvisible = (codePoint >= 0x200b && codePoint <= 0x200f) || (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069) || codePoint === 0xfeff;
    return forbiddenControl || bidiOrInvisible ? replacement : character;
  }).join("");
}
