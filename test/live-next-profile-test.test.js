const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBoolean,
  parseNumber,
  pickLowestButton
} = require("../src/live-navigation-runner");

test("parseBoolean handles false-like values", () => {
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean("false", true), false);
  assert.equal(parseBoolean("0", true), false);
  assert.equal(parseBoolean("true", false), true);
});

test("parseNumber falls back on invalid values", () => {
  assert.equal(parseNumber(undefined, 3), 3);
  assert.equal(parseNumber("abc", 3), 3);
  assert.equal(parseNumber("5", 3), 5);
});

test("pickLowestButton returns the lower candidate", () => {
  assert.deepEqual(
    pickLowestButton([
      { x: 10, y: 100, width: 40, height: 40 },
      { x: 10, y: 200, width: 40, height: 40 }
    ]),
    { x: 10, y: 200, width: 40, height: 40 }
  );
});
