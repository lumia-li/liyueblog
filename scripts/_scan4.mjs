import fs from "fs";
const p = "src/components/editor/DeveloperEditor.svelte";
const s = fs.readFileSync(p, "utf8");
const re = /ri18n\(I18nKey\.\w+\)/g;
let m;
const bad = [];
while ((m = re.exec(s))) {
  const before = s[m.index - 1];
  const after = s.slice(m.index + m[0].length);
  // inside a proper interpolation, before char is '{'
  if (before === "{") continue;
  // text-node ending markers that should follow an interpolation:
  if (/^\s*(<\/|\{\/|\{:|<\w)/.test(after)) {
    bad.push((m.index) + ": before=[" + before + "] ..." + s.slice(m.index - 14, m.index + m[0].length + 14) + "...");
  }
}
console.log("SUSPICIOUS (missing {} in text/block node):", bad.length);
console.log(bad.join("\n"));
