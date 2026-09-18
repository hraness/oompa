#!/usr/bin/env python3
"""Mechanically split a giant *.test.ts file's largest describe block into
N contiguous part files, hoisting every top-level helper declaration into
scripts/fixtures/<base>-testkit.ts so each part file stays self-contained.

Boundaries are found by a character-level scanner that understands strings,
template literals (with ${} nesting), and comments, so statements are never
cut inside a literal. Only test()/describe()/for/if/while statements are
chunk boundaries; describe-local declarations are hoisted to the testkit.
"""
import os
import re
import sys
import bisect
from pathlib import Path

CALL_STARTERS = ("describe", "test", "it", "afterEach", "beforeEach",
                 "beforeAll", "afterAll", "setDefaultTimeout")
HOOK_STARTERS = ("afterEach", "beforeEach", "beforeAll", "afterAll")
BLOCK_STARTERS = ("function", "class", "interface", "enum",
                  "for", "while", "if", "switch", "try", "do")
SEMI_STARTERS = ("const", "let", "var", "type")
CHUNK_BOUNDARIES = ("test", "describe", "for", "if", "while")
STMT_STARTERS = frozenset(CALL_STARTERS + BLOCK_STARTERS + SEMI_STARTERS
                          + ("export", "async", "await", "return", "yield",
                             "throw", "break", "continue", "debugger"))


def line_starts(text):
    offs = [0]
    for m in re.finditer("\n", text):
        offs.append(m.end())
    return offs


def scan_region(text, start, end):
    """Scan text[start:end]; return list of statement dicts with char spans."""
    stmts = []
    i = start
    n = end
    while i < n:
        # skip whitespace and comments
        while i < n:
            c = text[i]
            if c in " \t\r\n":
                i += 1
            elif text.startswith("//", i):
                j = text.find("\n", i)
                i = n if j < 0 else j + 1
            elif text.startswith("/*", i):
                j = text.find("*/", i + 2)
                if j < 0:
                    raise SystemExit(f"unterminated block comment at char {i}")
                i = j + 2
            else:
                break
        if i >= n:
            break
        stmt_start = i
        m = re.match(r'(?:export\s+)?(?:declare\s+)?(?:async\s+)?[\w$]+', text[i:])
        word = m.group(0) if m else ""
        first_word = re.match(r'[\w$]+', word).group(0) if word else ""
        if first_word in ("export", "declare", "async"):
            first_word = word.split()[-1]
        # find statement end
        i = scan_stmt_end(text, i, n, first_word)
        stmts.append({"start": stmt_start, "end": i, "word": first_word})
    return stmts


def scan_stmt_end(text, i, n, word):
    """Return char offset just past the end of the statement starting at i."""
    paren = bracket = curly = 0
    mode = "code"            # code | sq | dq | tpl | line | block
    tpl_stack = []           # curly depths where ${ opened inside templates
    j = i
    end_kind = "block" if word in BLOCK_STARTERS else "semi"
    while j < n:
        c = text[j]
        nxt = text[j + 1] if j + 1 < n else ""
        if mode == "line":
            if c == "\n":
                mode = "code"
        elif mode == "block":
            if c == "*" and nxt == "/":
                mode = "code"; j += 1
        elif mode == "sq":
            if c == "\\":
                j += 1
            elif c == "'":
                mode = "code"
        elif mode == "dq":
            if c == "\\":
                j += 1
            elif c == '"':
                mode = "code"
        elif mode == "tpl":
            if c == "\\":
                j += 1
            elif c == "`":
                mode = "code"
            elif c == "$" and nxt == "{":
                tpl_stack.append(curly)
                curly += 1
                mode = "code"
                j += 1
        else:  # code
            if c == "/" and nxt == "/":
                mode = "line"; j += 1
            elif c == "/" and nxt == "*":
                mode = "block"; j += 1
            elif c == "'":
                mode = "sq"
            elif c == '"':
                mode = "dq"
            elif c == "`":
                mode = "tpl"
            elif c == "(":
                paren += 1
            elif c == ")":
                paren -= 1
            elif c == "[":
                bracket += 1
            elif c == "]":
                bracket -= 1
            elif c == "{":
                curly += 1
            elif c == "}":
                curly -= 1
                if tpl_stack and curly == tpl_stack[-1]:
                    tpl_stack.pop()
                    mode = "tpl"
                elif paren == 0 and bracket == 0 and curly == 0:
                    if end_kind == "block":
                        # possible end; inspect the next significant token.
                        k = j + 1
                        while k < n:
                            if text[k] in " \t\r\n":
                                k += 1
                            elif text.startswith("//", k):
                                nl = text.find("\n", k)
                                k = n if nl < 0 else nl + 1
                            elif text.startswith("/*", k):
                                k = text.find("*/", k + 2) + 2
                            else:
                                break
                        if k >= n:
                            return j + 1
                        if text[k] == ";":
                            return k + 1
                        cont = re.match(r'(else|catch|finally|while)\b', text[k:])
                        if cont:
                            j = k + cont.end() - 1
                            continue
                        nxt = re.match(r'[\w$]+', text[k:])
                        if nxt and nxt.group(0) in STMT_STARTERS:
                            return j + 1
                        # anything else (e.g. > , : . ( in a type or expression)
                        # means the statement continues — keep scanning.
                    # else keep scanning for the semicolon
            elif c == ";" and paren == 0 and bracket == 0 and curly == 0:
                return j + 1
        j += 1
    raise SystemExit(f"statement starting at char {i} never terminated")


def stmt_text(text, s):
    return text[s["start"]:s["end"]]


def decl_names(text, s):
    """Local names bound by a declaration statement."""
    t = stmt_text(text, s)
    out = []
    m = re.match(r'\s*(?:export\s+)?(async\s+)?(const|let|var|function|class|interface|type|enum)\s*', t)
    if not m:
        return out
    kind = m.group(2)
    rest = t[m.end():]
    if kind in ("const", "let", "var"):
        rest = rest.lstrip()
        if rest[0] == "[":
            inner = rest[1:rest.find("]")]
            out += re.findall(r'[\w$]+', inner)
        elif rest[0] == "{":
            inner = rest[1:rest.find("}")]
            out += re.findall(r'[\w$]+', inner)
        else:
            nm = re.match(r'[\w$]+', rest)
            if nm:
                out.append(nm.group(0))
    else:
        nm = re.match(r'[\w$]+', rest)
        if nm:
            out.append(nm.group(0))
    return out


def strip_comments(text):
    out = []
    i, n = 0, len(text)
    mode = "code"
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if mode == "code":
            if c == "/" and nxt == "/":
                mode = "line"
                out.append(" ")
            elif c == "/" and nxt == "*":
                mode = "block"
                out.append(" ")
            elif c == "'":
                mode = "sq"; out.append(c)
            elif c == '"':
                mode = "dq"; out.append(c)
            elif c == "`":
                mode = "tpl"; out.append(c)
            else:
                out.append(c)
        elif mode == "line":
            if c == "\n":
                mode = "code"; out.append(c)
        elif mode == "block":
            if c == "*" and nxt == "/":
                mode = "code"; i += 1
            elif c == "\n":
                out.append("\n")
        elif mode == "sq":
            out.append(c)
            if c == "\\":
                i += 1; out.append(text[i])
            elif c == "'":
                mode = "code"
        elif mode == "dq":
            out.append(c)
            if c == "\\":
                i += 1; out.append(text[i])
            elif c == '"':
                mode = "code"
        elif mode == "tpl":
            out.append(c)
            if c == "\\":
                i += 1; out.append(text[i])
            elif c == "`":
                mode = "code"
        i += 1
    return "".join(out)


def used_names(text):
    # not after a word char or single dot (property access), but a spread
    # `...name` (two preceding dots) IS a use. Comments are stripped first;
    # string/template contents still count (they may hold real references).
    text = strip_comments(text)
    return set(re.findall(r'(?:(?<![\w$.])|(?<=\.\.))([A-Za-z_$][\w$]*)', text))


def parse_imports(text, starts):
    """Return (imports, body_start_char). Only the contiguous leading import
    block is parsed — later 'import' text (e.g. inside template literals) is
    treated as body."""
    imports = []
    last_end = 0
    i = 0
    n = len(text)
    while i < n:
        # skip blank lines and comments between imports
        while i < n:
            if text[i] in " \t\r\n":
                i += 1
            elif text.startswith("//", i):
                j = text.find("\n", i)
                i = n if j < 0 else j + 1
            elif text.startswith("/*", i):
                j = text.find("*/", i + 2)
                i = j + 2
            else:
                break
        if i >= n or not text.startswith("import", i):
            break
        e = scan_stmt_end(text, i, n, "import")
        stmt = text[i:e]
        i = e
        last_end = e
        mod = re.search(r'from\s+["\']([^"\']+)["\']', stmt)
        if not mod:
            continue
        entry = {"module": mod.group(1), "names": []}
        whole_type = stmt.lstrip().startswith("import type")
        inner = re.search(r'\{([^}]*)\}', stmt, re.S)
        star = re.search(r'\*\s+as\s+([\w$]+)', stmt)
        if star:
            entry["names"].append({"local": star.group(1), "imported": star.group(1),
                                   "kind": "star", "type": whole_type})
        if inner:
            for part in inner.group(1).split(","):
                part = part.strip()
                if not part:
                    continue
                is_type = whole_type or part.startswith("type ")
                part = re.sub(r'^type\s+', '', part)
                am = re.match(r'([\w$]+)\s+as\s+([\w$]+)', part)
                local, imported = (am.group(2), am.group(1)) if am else (part, part)
                entry["names"].append({"local": local, "imported": imported,
                                       "kind": "named", "type": is_type})
        default_m = re.match(r'import\s+(?:type\s+)?([\w$]+)\s*(?:,\s*[\{*]|from\b)', stmt)
        if default_m:
            entry["names"].insert(0, {"local": default_m.group(1),
                                      "imported": default_m.group(1),
                                      "kind": "default", "type": whole_type})
        imports.append(entry)
        last_end = e
    return imports, last_end


def emit_imports(imports, keep, remap=None):
    lines = []
    for entry in imports:
        kept = [n for n in entry["names"] if n["local"] in keep]
        if not kept:
            continue
        module = remap(entry["module"]) if remap else entry["module"]
        named = [n for n in kept if n["kind"] == "named"]
        head = [n for n in kept if n["kind"] != "named"]
        parts = [("type " if n["type"] else "") + n["local"] if n["kind"] == "default"
                 else f"* as {n['local']}" for n in head]
        if named:
            all_type = all(n["type"] for n in named)
            def render(nm):
                s = nm["imported"] if nm["imported"] == nm["local"] else f"{nm['imported']} as {nm['local']}"
                return s if (nm["type"] and all_type) else (f"type {s}" if nm["type"] else s)
            names_str = ", ".join(render(nm) for nm in named)
            if all_type and not parts:
                lines.append(f'import type {{ {names_str} }} from "{module}";')
            else:
                parts.append("{ " + names_str + " }")
        if parts:
            lines.append(f'import {", ".join(parts)} from "{module}";')
    return lines


def module_remap(orig_dir, kit_path):
    """Rewrite module specifiers so they resolve from kit_path's directory
    instead of the original test file's directory."""
    import os
    kit_dir = os.path.dirname(kit_path)
    def remap(mod):
        if not mod.startswith("."):
            return mod
        abs_path = os.path.normpath(os.path.join(orig_dir, mod))
        rel = os.path.relpath(abs_path, kit_dir)
        return rel if rel.startswith(".") else "./" + rel
    return remap


def emit_testkit_import(path, names):
    if not names:
        return []
    return ["import {", *[f"  {n}," for n in sorted(names)], f'}} from "{path}";']


def add_export(t):
    return re.sub(r'^(\s*)', 'export ', t, count=1)


def dedent(t, n=2):
    pad = " " * n
    return "\n".join(l[len(pad):] if l.startswith(pad) else l for l in t.split("\n"))


def fixup_meta_dir(src, orig_dir, kit_dir):
    """Re-anchor join(import.meta.dir, "a", "b") literals that resolved against
    the original test file's directory so they hit the same target from the
    emitted testkit's directory."""
    pat = re.compile(r'join\(import\.meta\.dir((?:\s*,\s*"[^"]*")+)\)')

    def repl(m):
        args = re.findall(r'"([^"]*)"', m.group(1))
        target = Path(orig_dir).joinpath(*args)
        rel = os.path.relpath(target, kit_dir)
        return f'join(import.meta.dir, "{rel}")'

    return pat.sub(repl, src)


def split_file(path, kit_path, parts, giant_filter):
    text = Path(path).read_text()
    starts = line_starts(text)
    imports, body_start = parse_imports(text, starts)

    stmts = scan_region(text, body_start, len(text))
    helpers, describes, hooks, timeouts = [], [], [], []
    for s in stmts:
        w = s["word"]
        if w == "setDefaultTimeout":
            timeouts.append(s)
        elif w in HOOK_STARTERS:
            hooks.append(s)
        elif w == "describe":
            describes.append(s)
        else:
            helpers.append(s)
    if len(hooks) != 1 or not timeouts:
        raise SystemExit(f"{path}: expected 1 hook + 1 timeout, got {len(hooks)}/{len(timeouts)}")

    giants = [d for d in describes if giant_filter(stmt_text(text, d))]
    if len(giants) != 1:
        raise SystemExit(f"{path}: expected 1 giant describe, got {len(giants)}")
    giant = giants[0]
    kept = [d for d in describes if d is not giant]

    # locate the giant describe's callback body braces
    gtext = stmt_text(text, giant)
    rel_open = gtext.index("{")
    # find matching close: scan from open
    depth = 0
    i = giant["start"] + rel_open
    # reuse scan: walk chars with string awareness
    mode = "code"; tpl_stack = []; j = i
    while True:
        c = text[j]; nxt = text[j + 1] if j + 1 < len(text) else ""
        if mode == "line":
            if c == "\n": mode = "code"
        elif mode == "block":
            if c == "*" and nxt == "/": mode = "code"; j += 1
        elif mode == "sq":
            if c == "\\": j += 1
            elif c == "'": mode = "code"
        elif mode == "dq":
            if c == "\\": j += 1
            elif c == '"': mode = "code"
        elif mode == "tpl":
            if c == "\\": j += 1
            elif c == "`": mode = "code"
            elif c == "$" and nxt == "{": tpl_stack.append(depth); depth += 1; mode = "code"; j += 1
        else:
            if c == "/" and nxt == "/": mode = "line"; j += 1
            elif c == "/" and nxt == "*": mode = "block"; j += 1
            elif c == "'": mode = "sq"
            elif c == '"': mode = "dq"
            elif c == "`": mode = "tpl"
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if tpl_stack and depth == tpl_stack[-1]:
                    tpl_stack.pop(); mode = "tpl"
                elif depth == 0:
                    break
        j += 1
    body_start_c, body_end_c = i + 1, j

    inner = scan_region(text, body_start_c, body_end_c)
    local_decls, segments = [], []
    pending_prefix = []
    for s in inner:
        w = s["word"]
        if w in HOOK_STARTERS:
            raise SystemExit(f"{path}: hook inside giant describe at char {s['start']} - refusing")
        if w in SEMI_STARTERS or w in ("function", "class", "interface", "type", "enum", "async"):
            local_decls.append(s)
        elif w in CHUNK_BOUNDARIES or w in ("it",):
            segments.append({"stmts": pending_prefix + [s]})
            pending_prefix = []
        else:
            pending_prefix.append(s)
    if pending_prefix:
        if segments:
            segments[-1]["stmts"].extend(pending_prefix)
        else:
            local_decls.extend(pending_prefix)
    print(f"{path}: hoisted {len(local_decls)} describe-local decls, "
          f"{len(segments)} test/describe/for segments, {len(helpers)} top-level helpers")

    base = Path(path).stem.replace(".test", "")
    dirn = Path(path).parent
    kit_rel = Path(kit_path)

    # ---- testkit content: helpers (top-level) + dedented describe-locals
    helper_stmts = helpers + local_decls
    for h in helper_stmts:
        if not decl_names(text, h):
            raise SystemExit(
                f"{path}: non-declaration top-level statement at char {h['start']}: "
                f"{stmt_text(text, h)[:80]!r} - refusing")
    helper_texts = [stmt_text(text, h) for h in helpers]
    helper_texts += [dedent(stmt_text(text, d)) for d in local_decls]
    kit_dir = str(Path(kit_path).parent)
    helper_texts = [fixup_meta_dir(t, str(dirn), kit_dir) for t in helper_texts]
    kit_body = "\n\n".join(add_export(t) for t in helper_texts)
    kit_used = used_names(kit_body)
    kit_names = set()
    for h in helpers + local_decls:
        kit_names.update(decl_names(text, h))
    kit_import_lines = emit_imports(imports, kit_used - kit_names,
                                    remap=module_remap(str(dirn), kit_path))
    kit_src = "\n".join(kit_import_lines) + "\n\n" + kit_body + "\n"
    Path(kit_path).write_text(kit_src)

    kit_spec = "../../" + str(kit_rel).replace(".ts", "")

    timeout_txt = stmt_text(text, timeouts[0])
    hook_txt = stmt_text(text, hooks[0])

    # ---- chunk segments into `parts` contiguous groups by line count
    sizes = []
    for seg in segments:
        seg_text = "".join(stmt_text(text, st) for st in seg["stmts"])
        seg["text"] = seg_text
        sizes.append(len(seg_text.split("\n")))
    total = sum(sizes)
    target = total / parts
    chunks, cur, cur_size = [], [], 0
    remaining_parts = parts
    for idx, seg in enumerate(segments):
        segs_left = len(segments) - idx
        if cur and cur_size >= target and segs_left >= remaining_parts - 1 and remaining_parts > 1:
            chunks.append(cur); cur = []; cur_size = 0; remaining_parts -= 1
        cur.append(seg); cur_size += sizes[idx]
    if cur:
        chunks.append(cur)
    while len(chunks) < parts:
        chunks.append([])
    if len(chunks) > parts:
        # merge tail into last
        tail = chunks[parts - 1:]
        chunks = chunks[:parts - 1] + [[s for c in tail for s in c]]
    print(f"{path}: chunk line counts {[sum(sizes[segments.index(s)] for s in c) for c in chunks]}")

    gname = re.match(r'\s*describe\(([^,]+)', gtext).group(1).strip()

    # ---- emit part files (giant chunks); part 0 replaces the giant inside main file? No:
    # main file keeps only non-giant describes; all giant chunks go to part files.
    for k in range(parts):
        chunk_text = "\n".join(seg["text"] for seg in chunks[k])
        body = f"describe({gname}, () => {{\n" + chunk_text + "\n});\n"
        file_text = timeout_txt + "\n\n" + hook_txt + "\n\n" + body
        u = used_names(file_text)
        lines = emit_imports(imports, u - kit_names)
        lines += emit_testkit_import(kit_spec, u & kit_names)
        out = "\n".join(lines) + "\n\n" + file_text
        suffix = f"-{k+1}" if parts > 1 else ""
        Path(dirn / f"{base}{suffix}.test.ts").write_text(out)

    # ---- rewrite original file: imports + testkit import + timeout/hook + kept describes
    main_body = timeout_txt + "\n\n" + "\n\n".join(stmt_text(text, d) for d in kept) + "\n\n" + hook_txt + "\n"
    u = used_names(main_body)
    lines = emit_imports(imports, u - kit_names)
    lines += emit_testkit_import(kit_spec, u & kit_names)
    Path(path).write_text("\n".join(lines) + "\n\n" + main_body)


if __name__ == "__main__":
    split_file("src/storage/state-store.test.ts",
               "scripts/fixtures/state-store-testkit.ts", 4,
               lambda t: t.startswith('describe("StateStore"'))
    split_file("src/daemon/service.test.ts",
               "scripts/fixtures/service-testkit.ts", 3,
               lambda t: t.startswith('describe("OompaService",'))
