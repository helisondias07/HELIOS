"use strict";
/**
 * LEVA K: instala skills verificadas em Documents\HELIOS\skills (ou HELIOS_SKILLS_DIR).
 * Sem instaladores globais. web-design-guidelines sem licença → skipped no manifest.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createSkillFs } = require("../server/skill-fs");
const { KNOWN_SKILL_SOURCES } = require("../server/skill-install");

const skillsDir = process.env.HELIOS_SKILLS_DIR || path.join(os.homedir(), "Documents", "HELIOS", "skills");
const dataDir = process.env.HELIOS_SKILLS_DATA || path.join(os.homedir(), "Documents", "HELIOS");
const report = [];

fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const skillFs = createSkillFs({
  skillsDir,
  dataDir,
  bundleDir: path.join(__dirname, "..", "design", "skills"),
  repoRoot: path.join(__dirname, ".."),
});

function gitClone(url, { branch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-skill-clone-"));
  const args = ["clone", "--depth", "1"];
  if (branch) args.push("-b", branch);
  args.push(url, dir);
  execFileSync("git", args, { stdio: "pipe", windowsHide: true });
  let commit = null;
  try { commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(); } catch { /* ok */ }
  return { dir, commit };
}

(async () => {
  // de-slop-ui do bundle
  try {
    const r = await skillFs.installKnown("de-slop-ui", { approve: true });
    report.push({ name: "de-slop-ui", ...r, source: "design/skills/de-slop-ui" });
  } catch (e) {
    report.push({ name: "de-slop-ui", ok: false, error: e.message });
  }

  for (const spec of KNOWN_SKILL_SOURCES) {
    if (spec.name === "de-slop-ui") continue;
    try {
      const r = await skillFs.installKnown(spec.name, { approve: true, gitCloneFn: gitClone });
      report.push({ name: spec.name, source: spec.sourceUrl, licenseExpected: spec.licenseExpected, ...r });
    } catch (e) {
      report.push({ name: spec.name, source: spec.sourceUrl, ok: false, error: e.message });
    }
  }

  skillFs.ensureDefaults();
  const out = path.join(os.tmpdir(), "levaK-skills-install.json");
  fs.writeFileSync(out, JSON.stringify({ skillsDir, manifest: skillFs.listManifest(), report, assignments: skillFs.assignments() }, null, 2));
  console.log(JSON.stringify({ skillsDir, report, manifest: skillFs.listManifest() }, null, 2));
  console.log("report:", out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
