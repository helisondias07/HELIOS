"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assertSdkPackaging, readPackage } = require("../scripts/check-sdk-pack");

test("o pacote declara zod e descompacta o SDK como no app instalado", () => {
  const pkg = readPackage();
  assert.doesNotThrow(() => assertSdkPackaging(pkg));
  const source = fs.readFileSync(path.join(__dirname, "..", "server", "sdk-load.js"), "utf8");
  assert.match(source, /require\("@cursor\/sdk"\)/);
  assert.match(source, /SDK_AUSENTE/);
});
