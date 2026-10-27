"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("instância única: a segunda abertura traz a janela existente em vez de subir outro servidor", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /if \(!app\.requestSingleInstanceLock\(\)\) \{\s*app\.quit\(\);\s*\} else \{\s*bootstrap\(\);/);
  assert.match(main, /app\.on\("second-instance", \(\) => showMain\(\)\)/);
});