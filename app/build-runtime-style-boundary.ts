import { createHash } from "node:crypto";
import ts from "typescript";

type JavaScriptArtifact = Readonly<{ name: string; text: string }>;
type ReactDomEvidence = Readonly<{
  manifest: unknown;
  productionClientSha256: string;
}>;

// React DOM can render a hoisted <style> when an application requests one. Its
// dormant renderer capability is not StyleX injection and is not permission to
// use it: the browser gate still rejects every style node/mutation and CSP error.
// These fingerprints bind the reviewed 19.2.8 source and its complete parsed
// acquireResource function in the production graph, not a nearby string/count.
// The reviewed allocations differ only by consistent minifier identifiers.
// Keep their exact raw function bytes: normalization could conceal a changed
// free helper. Every other allocation or body requires a new source review.
const reviewedProductionClientSha256 = "6cf4932e0c20a4572ae395035ca2e512a42d7d49c1a659fa73d6197069c28df0";
const reviewedResourceFunctionSha256s = new Set([
  "74ab0afc61ff2c3e1da3fe4d3b0785b82183692eaefb76e5d7d0d929de8ffd02",
  "af7ba8a59ab723dd7490ff6208468608f861cf85d89006d0aae02fd916b05bd6",
  "1335a9f7eaab4f7abe5eb52faa5544e978df547d7b2b29463c7b416497836a49",
  "aa79753fad24834ea666e2d099583de1ecbf38a2d1f10149893a0b2427c230a3",
  "7f077d5fb8c52e4dfa18bdf188c9b2ba9e03f28a626080e7d69a5e20b0b9fda6",
  "87ae7be84d98dfd2138dfd2b7709c82e09ce1d595300c3773dfa988ae5ffc2a8",
  "c8930b3dbd9f7a698c3f9089d32ba982b9684cf87625a70a44f8a75cf75f7a40",
  // Inline-conversation cards (2026-09-10): same function, new identifiers.
  "78bf0a7eede24af540a4a0068a29919376f5cc95c573f1ed9d539fe38ab1dbf3",
  // Astra bindings with inline conversations: same function, new identifiers.
  "903dddf7c88da8242677c566f0cd3bc889a4504e8ca0397743fb1403d392bd9e",
  // Browser automatic effort (2026-09-10): same function, new identifiers.
  "38c65e36bdaa72af11d634e191f31be3f940b40a55f8f1061fa0205cef460ad2",
  // Converged Astra, automatic effort and usage history: reviewed identifier allocation.
  "5c853b84598085dbe0243144241bbe3067519cf9cffbe89501d2bd04636cdef7",
]);
const stylexInjector = /stylex-inject|stylexInject|data-stylex|stylesheet-group/u;
const unreviewedLiteralCall = /createElement\s*\(\s*["']style["']\s*\)|\.insertRule\s*\(/u;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Parser roots have no parent at runtime, despite Node.parent's required type.
function parentNode(node: ts.Node): ts.Node | undefined {
  return node.parent;
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)
    && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

export function assertReviewedRuntimeStyleBoundary(
  artifacts: readonly JavaScriptArtifact[],
  evidence: ReactDomEvidence,
): void {
  const manifest = evidence.manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || !("name" in manifest) || manifest.name !== "react-dom"
    || !("version" in manifest) || manifest.version !== "19.2.8"
    || evidence.productionClientSha256 !== reviewedProductionClientSha256) {
    throw new Error("Unreviewed React DOM dependency identity at the runtime style boundary");
  }

  let reviewedCalls = 0;
  for (const artifact of artifacts) {
    if (stylexInjector.test(artifact.text)) {
      throw new Error(`StyleX runtime injector in ${artifact.name}`);
    }
    const source = ts.createSourceFile(
      artifact.name, artifact.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
    );
    // TypeScript exposes parser diagnostics on the parse result, but not on its
    // public SourceFile interface. Fail closed if that parser contract changes.
    const diagnostics: unknown = Reflect.get(source, "parseDiagnostics");
    if (!Array.isArray(diagnostics) || diagnostics.length !== 0) {
      throw new Error(`Cannot parse runtime style boundary in ${artifact.name}`);
    }

    const reviewedSpans: Readonly<{ start: number; end: number }>[] = [];
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const method = propertyName(node.expression);
        if (method === "insertRule") {
          throw new Error(`Unreviewed insertRule call in ${artifact.name}`);
        }
        const tag = node.arguments[0];
        if (method === "createElement" && tag !== undefined
          && ts.isStringLiteralLike(tag) && tag.text.toLowerCase() === "style") {
          let clause = parentNode(node);
          while (clause !== undefined && !ts.isCaseClause(clause)
            && !ts.isFunctionLike(clause)) clause = parentNode(clause);
          let owner: ts.Node | undefined = clause;
          while (owner !== undefined && !ts.isFunctionLike(owner)) owner = parentNode(owner);
          if (clause === undefined || !ts.isCaseClause(clause)
            || !ts.isStringLiteralLike(clause.expression) || clause.expression.text !== "style"
            || owner === undefined || !ts.isFunctionDeclaration(owner)
            || !reviewedResourceFunctionSha256s.has(sha256(owner.getText(source)))) {
            throw new Error(`Unreviewed style creation context in ${artifact.name}`);
          }
          reviewedCalls += 1;
          if (reviewedCalls !== 1) throw new Error("Duplicate React DOM style creation context");
          reviewedSpans.push({ start: owner.getStart(source), end: owner.end });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);

    // Retain the generic artifact guard outside the exact AST-owned function,
    // including suspicious literal fragments that are not executable AST calls.
    const reviewedSpan = reviewedSpans[0];
    const unreviewed = reviewedSpan === undefined ? artifact.text
      : artifact.text.slice(0, reviewedSpan.start) + artifact.text.slice(reviewedSpan.end);
    if (unreviewedLiteralCall.test(unreviewed)) {
      throw new Error(`Unreviewed runtime style call in ${artifact.name}`);
    }
  }
  if (reviewedCalls !== 1) throw new Error("Missing reviewed React DOM style creation context");
}
