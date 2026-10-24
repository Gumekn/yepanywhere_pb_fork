/** Guard the client typography contract across CSS, inline React styles and SVG.
 * Run: pnpm lint:typography. Uses parsers, not a grandfathered violation baseline.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY = "packages/client/src/styles/typography.css";
const FONT_SIZE_HOOK = "packages/client/src/hooks/useFontSize.ts";
const ERROR_BOUNDARY = "packages/client/src/components/ErrorBoundary.tsx";
const TERMINAL = "packages/client/src/pages/TerminalPage.tsx";
const TERMINAL_FACE = "packages/client/src/styles/terminal-font.css";

function readTokens(root) {
  const result = new Set();
  postcss
    .parse(readFileSync(path.join(root, AUTHORITY), "utf8"))
    .walkDecls((decl) => {
      if (/^--font-(?:size-|sans$|mono$)/u.test(decl.prop))
        result.add(decl.prop);
    });
  return result;
}

const names = {
  fontSize: "font-size",
  fontFamily: "font-family",
  font: "font",
};
const terminalValues = {
  "font-size": new Set(["13"]),
  "font-family": new Set([
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    '"Yep Terminal", monospace',
  ]),
};

function validate(
  property,
  value,
  file,
  tokens,
  { svgBadge = false, fontFace = false, selector = "" } = {},
) {
  if (/^--font-(?:size-|sans$|mono$)/u.test(property)) {
    return file === AUTHORITY
      ? null
      : "Typography tokens may only be defined in styles/typography.css.";
  }
  if (!["font", "font-size", "font-family"].includes(property)) return null;
  // Narrow technical exceptions, not file-wide exemptions:
  // - xterm takes concrete pixel metrics/families rather than CSS variables;
  // - a font-face names an asset, not an application text style;
  // - the small A inside a 24-unit SVG is part of its icon geometry;
  // - the splash renders before the application stylesheet is available.
  if (file === TERMINAL && terminalValues[property]?.has(value)) return null;
  if (
    file === TERMINAL_FACE &&
    fontFace &&
    property === "font-family" &&
    value === '"Yep Terminal"'
  )
    return null;
  if (svgBadge && property === "font-size" && value === "8") return null;
  if (
    file === "packages/client/index.html" &&
    ((selector === "#splash" &&
      property === "font-family" &&
      value ===
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif') ||
      (selector === "#splash-label" &&
        property === "font-size" &&
        value === "13px"))
  )
    return null;
  if (value === "inherit") return null;
  if (property === "font-size" && value === "0") return null;
  const match = /^var\((--[\w-]+)(?:,\s*([\s\S]+))?\)$/u.exec(value ?? "");
  if (
    match &&
    tokens.has(match[1]) &&
    ((property === "font-size" && match[1].startsWith("--font-size-")) ||
      (property === "font-family" &&
        ["--font-sans", "--font-mono"].includes(match[1])))
  ) {
    if (!match[2] || file === ERROR_BOUNDARY) return null;
    return "Do not add local font fallbacks; they hide missing tokens. Only the crash screen needs CSS-free fallbacks.";
  }
  return property === "font"
    ? 'Only "font: inherit" is allowed; select a size and family token separately.'
    : `Use a defined ${property === "font-size" ? "--font-size-*" : "--font-sans / --font-mono"} token or inherit; found ${JSON.stringify(value ?? "dynamic expression")}.`;
}

export function inspectCss(
  source,
  file,
  tokens = readTokens(ROOT),
  lineOffset = 0,
) {
  const issues = [];
  let root;
  try {
    root = postcss.parse(source, { from: file });
  } catch (error) {
    return [
      { file, line: error.line ?? 1, message: error.reason ?? error.message },
    ];
  }
  root.walkDecls((decl) => {
    const property = decl.prop.toLowerCase();
    if (file === AUTHORITY && property.startsWith("--")) return;
    const message = validate(property, decl.value.trim(), file, tokens, {
      fontFace:
        decl.parent.type === "atrule" && decl.parent.name === "font-face",
      selector: decl.parent.selector,
    });
    if (message)
      issues.push({
        file,
        line: (decl.source?.start?.line ?? 1) + lineOffset,
        message,
      });
  });
  return issues;
}

function textValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return node.text;
  if (ts.isJsxExpression(node)) return textValue(node.expression);
  return undefined;
}

function isSvgBadge(attribute) {
  const element = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(element) || element.tagName.getText() !== "text")
    return false;
  for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) {
    if (
      ts.isJsxElement(ancestor) &&
      ancestor.openingElement.tagName.getText() === "svg"
    )
      return true;
  }
  return false;
}

export function inspectTypeScript(source, file, tokens = readTokens(ROOT)) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const issues = [];
  const report = (node, property, value, options) => {
    const message = validate(property, value, file, tokens, options);
    if (message)
      issues.push({
        file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        message,
      });
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name)
        ? textValue(node.name.expression)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : textValue(node.name);
      // UI_KEYS.fontSize names a persisted preference, not a text style.
      const preferenceKey =
        file === "packages/client/src/lib/storageKeys.ts" &&
        name === "fontSize" &&
        textValue(node.initializer) === "yep-anywhere-font-size";
      if (name && !preferenceKey)
        report(node, names[name] ?? name, textValue(node.initializer));
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(ast);
      const property = names[name] ?? name;
      if (["font", "font-size", "font-family"].includes(property))
        report(node, property, textValue(node.initializer), {
          svgBadge: isSvgBadge(node),
        });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = node.left;
      const name = ts.isPropertyAccessExpression(left)
        ? left.name.text
        : ts.isElementAccessExpression(left)
          ? textValue(left.argumentExpression)
          : undefined;
      if (
        name &&
        names[name] &&
        !(
          file === FONT_SIZE_HOOK && left.getText(ast) === "root.style.fontSize"
        )
      )
        report(node, names[name], textValue(node.right));
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setProperty"
    ) {
      const name = textValue(node.arguments[0]);
      if (name) report(node, name, textValue(node.arguments[1]));
    }
    // Catch static CSS inside generated HTML/template strings as well.
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const attributes = [
        ...node.text.matchAll(/\bstyle=(['"])([\s\S]*?)\1/gu),
      ];
      if (attributes.length) {
        for (const match of attributes) {
          for (const issue of inspectCss(
            `.generated { ${match[2]} }`,
            file,
            tokens,
          ))
            issues.push({
              ...issue,
              line:
                ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            });
        }
      } else {
        for (const match of node.text.matchAll(
          /\b(font-size|font-family|font)\s*:\s*([^;{}]+)[;}]/gu,
        ))
          report(node, match[1], match[2].trim());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return issues;
}

export function inspectProject(root = ROOT) {
  const tokens = readTokens(root);
  const issues = [];
  let files = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["__tests__", "__mocks__"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (
        !/\.(?:css|[cm]?[jt]sx?)$/u.test(entry.name) ||
        /\.(?:test|spec)\.|\.d\.ts$/u.test(entry.name)
      )
        continue;
      const file = path.relative(root, absolute).split(path.sep).join("/");
      const source = readFileSync(absolute, "utf8");
      files++;
      issues.push(
        ...(file.endsWith(".css")
          ? inspectCss(source, file, tokens)
          : inspectTypeScript(source, file, tokens)),
      );
    }
  };
  walk(path.join(root, "packages/client/src"));
  const html = readFileSync(
    path.join(root, "packages/client/index.html"),
    "utf8",
  );
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    const offset =
      html.slice(0, match.index + match[0].indexOf(">") + 1).split("\n")
        .length - 1;
    issues.push(
      ...inspectCss(match[1], "packages/client/index.html", tokens, offset),
    );
  }
  return { issues, files };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { issues, files } = inspectProject();
  for (const issue of issues)
    console.error(`${issue.file}:${issue.line}: ${issue.message}`);
  if (issues.length) {
    console.error(
      `Typography check failed: ${issues.length} issue(s). See docs/project/typography.md.`,
    );
    process.exitCode = 1;
  } else console.log(`Typography check passed (${files} client source files).`);
}
