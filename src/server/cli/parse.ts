export type CliFlags = {
  json: boolean;
  inputJson?: string;
  inputFile?: string;
  bytesFile?: string;
  source?: string;
  agentId?: string;
  departmentId?: string;
  jobId?: string;
  key?: string;
  bindingId?: string;
  claimedBbProjectId?: string;
};

export type ParsedAgencyArgv = {
  tokens: string[];
  flags: CliFlags;
};

const VALUE_FLAGS: Record<string, keyof CliFlags> = {
  "--input-json": "inputJson",
  "--input-file": "inputFile",
  "--bytes-file": "bytesFile",
  "--source": "source",
  "--agent-id": "agentId",
  "--department-id": "departmentId",
  "--job-id": "jobId",
  "--key": "key",
  "--binding-id": "bindingId",
  "--claimed-bb-project-id": "claimedBbProjectId",
};

export function parseAgencyArgv(argv: string[]): ParsedAgencyArgv | { error: string } {
  const tokens: string[] = [];
  const flags: CliFlags = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      const field = Object.hasOwn(VALUE_FLAGS, name) ? VALUE_FLAGS[name] : undefined;
      if (!field) return { error: `unknown flag ${name}` };
      if (field === "json") return { error: "invalid flag" };
      flags[field] = value;
      continue;
    }
    const field = Object.hasOwn(VALUE_FLAGS, arg) ? VALUE_FLAGS[arg] : undefined;
    if (field) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return { error: `${arg} requires a value` };
      if (field === "json") return { error: "invalid flag" };
      flags[field] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && arg !== "--help") return { error: `unknown flag ${arg}` };
    tokens.push(arg);
  }
  return { tokens, flags };
}
