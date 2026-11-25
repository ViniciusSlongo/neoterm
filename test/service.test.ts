import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { findExecutable, servicePlist } from "../src/cli/service.ts";

const spec = {
  label: "com.neoterm.daemon",
  node: "/opt/homebrew/bin/node",
  script: "/Users/alguém/Projects/neoterm/bin/neoterm.js",
  workingDirectory: "/Users/alguém/.neoterm",
  log: "/Users/alguém/.neoterm/daemon.log",
  env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", NEOTERM_HOME: "/tmp/a & <b>" },
};

describe("ligar junto com o Mac", () => {
  it("monta o LaunchAgent que roda o motor no login e de novo se cair", () => {
    const plist = servicePlist(spec);
    assert.match(plist, /<key>Label<\/key>\n\t<string>com\.neoterm\.daemon<\/string>/);
    assert.match(
      plist,
      /<string>\/opt\/homebrew\/bin\/node<\/string>\n\t\t<string>\/Users\/alguém\/Projects\/neoterm\/bin\/neoterm\.js<\/string>\n\t\t<string>daemon<\/string>/,
    );
    assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
    assert.match(plist, /<key>SuccessfulExit<\/key>\n\t\t<false\/>/);
    assert.match(plist, /<string>\/tmp\/a &amp; &lt;b&gt;<\/string>/, "escapa o XML");
  });

  it("gera um plist que o macOS aceita", { skip: process.platform !== "darwin" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "neoterm-plist-"));
    const file = join(dir, "x.plist");
    writeFileSync(file, servicePlist(spec));
    const json = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    assert.deepEqual(json.ProgramArguments, [spec.node, spec.script, "daemon"]);
    assert.equal(json.EnvironmentVariables.NEOTERM_HOME, "/tmp/a & <b>");
    assert.deepEqual(json.KeepAlive, { SuccessfulExit: false });
  });

  it("acha o programa no PATH, só se for executável", () => {
    const first = mkdtempSync(join(tmpdir(), "neoterm-path-"));
    const second = mkdtempSync(join(tmpdir(), "neoterm-path-"));
    writeFileSync(join(first, "claude"), "não executável");
    writeFileSync(join(second, "claude"), "#!/bin/sh\n");
    chmodSync(join(second, "claude"), 0o755);
    const path = [first, second].join(delimiter);
    assert.equal(findExecutable("claude", path), join(second, "claude"));
    assert.equal(findExecutable("nada", path), undefined);
    assert.equal(findExecutable(join(second, "claude"), ""), join(second, "claude"));
  });
});
