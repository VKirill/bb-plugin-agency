import { describe, expect, it } from "vitest";
import { fileToAcceptTarget } from "../src/app/data/job-lifecycle";
import { mapJobFilesFromArtifacts, mergeJobFiles, parseJobArtifactGroups } from "../src/app/data/job-artifacts";
import { mapJobFiles } from "../src/app/data/view-models";
import { formatFileChipMeta } from "../src/app/prototype/task-files";

const HASH = "ff643aa97d3e8a1dee12d535ea5da7d3f423b9eef66657e54dac8437da95a1ac";
const ART = "art_4a88eeed059f763ca58e3097";

const liveGetJobArtifacts = [{
  artifact: { id: ART, jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa" },
  versions: [{
    artifactId: ART,
    version: 1,
    hash: HASH,
    relativePath: "notes/qa-release-1608.md",
    size: 1885,
  }],
}];

describe("mapJobFiles worker publish", () => {
  it("keeps id+version+hash+path from real getJob versions", () => {
    const files = mapJobFiles({ artifacts: liveGetJobArtifacts });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: ART,
      name: "qa-release-1608.md",
      size: 1885,
      version: 1,
      hash: HASH,
    });
    expect(fileToAcceptTarget(files[0]!)).toEqual({ artifactId: ART, version: 1, hash: HASH });
    expect(formatFileChipMeta(files[0]!)).toBe("2 КБ · v1 · ff643aa9 · Открыть");
    expect(formatFileChipMeta({ size: 0 })).toBe("0 Б · Открыть");
  });

  it("accepts a single versions object and snake_case rows", () => {
    const files = mapJobFilesFromArtifacts([{
      artifact: { id: ART, job_id: "job_aaaaaaaaaaaaaaaaaaaaaaaa" },
      versions: {
        artifact_id: ART,
        job_id: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
        version: "1",
        hash: HASH,
        relative_path: "notes/qa-release-1608.md",
        size: 1885,
      },
    }]);
    expect(files[0]?.version).toBe(1);
    expect(files[0]?.name).toBe("qa-release-1608.md");
    expect(fileToAcceptTarget(files[0]!)).toBeTruthy();
  });

  it("does not let a local stub without version hide the published file", () => {
    const remote = mapJobFiles({ artifacts: liveGetJobArtifacts });
    const merged = mergeJobFiles([{ id: ART, name: ART, size: 0, content: "", kind: "text" }], remote);
    expect(fileToAcceptTarget(merged[0]!)).toEqual({ artifactId: ART, version: 1, hash: HASH });
    expect(merged[0]?.name).toBe("qa-release-1608.md");
  });

  it("drops artifact groups without a usable version instead of inventing a chip", () => {
    expect(parseJobArtifactGroups([{ artifact: { id: ART, jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa" }, versions: [] }])).toEqual([
      { artifact: { id: ART, jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa" }, versions: [] },
    ]);
    expect(mapJobFilesFromArtifacts([{ artifact: { id: ART, jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa" }, versions: [] }])).toEqual([]);
  });
});
