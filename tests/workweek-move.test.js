const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "..", "workweek.html"), "utf8");
const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261104203000_workweek_move_in_place.sql"), "utf8");

test("placed chips can be dragged and tap-selected", () => {
  assert.match(html, /chip tchip\$\{picked === id \? " picked" : ""\}" draggable="true" data-id="\$\{id\}"/);
  assert.match(html, /addEventListener\("dragstart"[\s\S]*?closest\("\.chip\[data-id\]"\)/);
  assert.match(html, /addEventListener\("click"[\s\S]*?closest\("\.chip\[data-id\]"\)/);
  assert.match(html, /data-unplace="\$\{key\}\|\$\{id\}"/);
});

test("place moves the existing row in place and keeps one per week", () => {
  const place = sql.slice(sql.indexOf("when 'place'"), sql.indexOf("when 'unplace'"));
  assert.match(place, /update public\.workweek_placements\s+set block_date = v_date, block_start = v_start/);
  assert.match(place, /if v_row is null then\s+insert/);
  assert.match(place, /isodow/);
  assert.ok(!/delete from public\.workweek_placements p\s+where p\.reminder_id = v_id\s+and p\.block_date/.test(place), "no delete-all-then-insert");
});

test("blocks with placed chips grow to fit and later blocks slide down", () => {
  assert.match(html, /function fitBlocks\(\)/);
  assert.match(html, /fitBlocks\(\);\s*\n\s*document\.getElementById\("hint"\)/);
  assert.match(html, /b\.scrollHeight/);
});
