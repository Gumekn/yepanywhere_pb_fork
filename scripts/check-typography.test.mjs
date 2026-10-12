import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import {
  inspectCss,
  inspectProject,
  inspectTypeScript,
} from "./check-typography.mjs";

const cssFile = "packages/client/src/pages/new-page.css";
const tsFile = "packages/client/src/pages/NewPage.tsx";

test("accepts the shared roles and inheritance without mistaking comments for styles", () => {
  assert.deepEqual(
    inspectCss(
      "/* font-size: 88px; */ .panel { font: inherit; font-size: var(--font-size-base); font-family: var(--font-sans); }",
      cssFile,
    ),
    [],
  );
  assert.deepEqual(
    inspectTypeScript(
      'const ui = <div style={{ fontSize: "var(--font-size-sm)", fontFamily: "inherit" }} />;',
      tsFile,
    ),
    [],
  );
});

test("rejects hardcoded and compounded CSS sizes, custom stacks and unknown tokens", () => {
  for (const value of [
    "14px",
    "1rem",
    "0.85em",
    "120%",
    "larger",
    "var(--font-size-md)",
    "calc(var(--font-size-base) * 2)",
    "var(--font-size-base, 13px)",
  ]) {
    assert.equal(
      inspectCss(`.panel { font-size: ${value}; }`, cssFile).length,
      1,
      value,
    );
  }
  assert.equal(
    inspectCss(
      '.panel { font-family: "Inter", sans-serif; font: 12px Arial; }',
      cssFile,
    ).length,
    2,
  );
});

test("catches inline styles, quoted keys, DOM writes and CSS in generated HTML", () => {
  const source = `
    const styles = { "fontSize": "14px", fontFamily: "Arial" };
    const ui = <div style={{fontSize: 17}} />;
    element.style.fontSize = "16px";
    element.style.setProperty("font-size", "1rem");
    const html = '<footer style="font-size:12px;">note</footer>';
  `;
  assert.equal(inspectTypeScript(source, tsFile).length, 6);
  assert.equal(
    inspectTypeScript(
      "const html = `<span style='font-size:12px'>note</span>`;",
      tsFile,
    ).length,
    1,
  );
});

test("prevents local token redefinitions and rejects unreviewable dynamic sizes", () => {
  assert.equal(
    inspectCss(".new-page { --font-size-base: 17px; }", cssFile).length,
    1,
  );
  assert.equal(
    inspectTypeScript(
      'root.style.setProperty("--font-size-base", "17px"); const s = {fontSize: arbitrary};',
      tsFile,
    ).length,
    2,
  );
});

test("keeps SVG-coordinate exceptions within the icon and terminal exceptions within the adapter", () => {
  assert.deepEqual(
    inspectTypeScript(
      '<svg viewBox="0 0 24 24"><text fontSize="8" fontFamily="var(--font-sans)">A</text></svg>',
      tsFile,
    ),
    [],
  );
  assert.equal(
    inspectTypeScript('<text fontSize="8">A</text>', tsFile).length,
    1,
  );
  assert.equal(
    inspectTypeScript('<svg><text font-size="16">Label</text></svg>', tsFile)
      .length,
    1,
  );
  assert.deepEqual(
    inspectTypeScript(
      "const options = {fontSize: 13};",
      "packages/client/src/pages/TerminalPage.tsx",
    ),
    [],
  );
  assert.equal(
    inspectTypeScript(
      "const options = {fontSize: 22};",
      "packages/client/src/pages/TerminalPage.tsx",
    ).length,
    1,
  );
  assert.equal(
    inspectTypeScript("const options = {fontSize: 13};", tsFile).length,
    1,
  );
});

test("allows CSS-free crash fallback only for a known token in the crash screen", () => {
  const fallback = 'const s = {fontSize: "var(--font-size-base, 13px)"};';
  assert.deepEqual(
    inspectTypeScript(
      fallback,
      "packages/client/src/components/ErrorBoundary.tsx",
    ),
    [],
  );
  assert.equal(inspectTypeScript(fallback, tsFile).length, 1);
  assert.equal(
    inspectTypeScript(
      'const s = {fontSize: "var(--font-size-typo, 13px)"};',
      "packages/client/src/components/ErrorBoundary.tsx",
    ).length,
    1,
  );
});

test("foundation gives unstyled pages and portal siblings a base and controls inherit it", () => {
  const source = readFileSync(
    new URL("../packages/client/src/styles/typography.css", import.meta.url),
    "utf8",
  );
  const css = postcss.parse(source);
  const body = css.nodes.find(
    (node) => node.type === "rule" && node.selector === "body",
  );
  const bodyDeclarations = Object.fromEntries(
    body.nodes
      .filter((node) => node.type === "decl")
      .map((node) => [node.prop, node.value]),
  );
  assert.equal(bodyDeclarations["font-size"], "var(--font-size-base)");
  assert.equal(bodyDeclarations["font-family"], "var(--font-sans)");
  const controls = css.nodes.find(
    (node) => node.type === "rule" && node.selectors?.includes("textarea"),
  );
  assert.deepEqual(controls.selectors, [
    "button",
    "input",
    "select",
    "textarea",
  ]);
  assert(
    controls.nodes.some(
      (node) => node.prop === "font" && node.value === "inherit",
    ),
  );
  const tokens = new Map();
  css.walkDecls(/^--font-size-/u, (decl) => tokens.set(decl.prop, decl.value));
  for (const role of [
    "xs",
    "sm",
    "base",
    "lg",
    "xl",
    "2xl",
    "3xl",
    "title",
    "reading",
  ])
    assert.match(tokens.get(`--font-size-${role}`), /^[\d.]+rem$/u);
  assert.equal(tokens.get("--font-size-base"), "0.8125rem");
  assert.equal(
    tokens.get("--font-size-input"),
    "max(16px, var(--font-size-base))",
  );
});

test("all current client sources pass without a grandfathered baseline", () => {
  const { issues, files } = inspectProject();
  assert(files > 100);
  assert.deepEqual(issues, []);
});
