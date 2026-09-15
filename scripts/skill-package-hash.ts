import { hashSkillPackageRoot } from "../src/server/runtime/prepare-run/skill-package-fs.ts";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: skill-package-hash <skill-root>\n");
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(hashSkillPackageRoot(root), null, 2)}\n`);
