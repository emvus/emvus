#!/usr/bin/env python3
"""Runs Ring1 on Emerald: translates the Ring1 subset of Emvus to Emerald and writes a program.

Usage: emvusToEmerald.py <ring0-binary> <out-dir> <file.ev>...

The sources are parsed by Ring0 (`--ast`), so the translator only sees the tree. It covers exactly the
constructs Ring1 is written in (see Ring1/README.md); anything else stops with an error. This is a test
harness, not a second compiler: its only purpose is to execute Ring1 before the Sublang backend can.
"""
import os
import subprocess
import sys

BUILTIN_RENAMES = {"size": "length"}
ASCII_TABLE = "".join(chr(code) for code in range(32, 127))


class Node:
    def __init__(self, kind, text):
        self.kind, self.text, self.children = kind, text, []


def unescape(text):
    out, i = [], 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            out.append({"n": "\n", "r": "\r", "t": "\t", "\\": "\\"}.get(text[i + 1], text[i + 1]))
            i += 2
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def read_tree(dump):
    root, stack = None, []
    for line in dump.split("\n"):
        if not line.strip():
            continue  # the blank line println adds
        depth = (len(line) - len(line.lstrip(" "))) // 2
        kind, _, text = line.lstrip(" ").partition(" ")
        node = Node(kind, unescape(text))
        if depth == 0:
            root = node
        else:
            stack[depth - 1].children.append(node)
        del stack[depth:]
        stack.append(node)
    return root


def emerald_string(text):
    escaped = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return '"' + escaped + '"'


class Translator:
    def __init__(self, root):
        self.constants = {}
        self.list_arities = set()
        self.methods = []
        for declaration in root.children:
            if declaration.kind == "variable":
                self.constants[declaration.text] = self.constant(declaration.children[-1])
        for declaration in root.children:
            if declaration.kind == "method":
                self.methods.append(self.method(declaration))

    def constant(self, node):
        if node.kind == "int-literal":
            return int(node.text)
        if node.kind == "unary" and node.text == "-":
            return -self.constant(node.children[0])
        if node.kind == "name":
            return self.constants[node.text]
        raise ValueError("unsupported constant " + node.kind)

    def type(self, node):
        if node.text == "Bool":
            return "Bool"
        if not node.children:
            return node.text
        return node.text + "<" + ", ".join(self.type(child) for child in node.children) + ">"

    def method(self, node):
        name = "main" if node.text == "main" else node.text
        returns = "Void"
        params = []
        body = None
        for child in node.children:
            if child.kind == "return-type":
                returns = self.type(child.children[0])
            elif child.kind == "params":
                params = ["%s v_%s" % (self.type(p.children[1]), p.text) for p in child.children]
            elif child.kind == "block":
                body = child
        lines = ["    public static %s m_%s(%s) {" % (returns, name, ", ".join(params))]
        lines += self.block(body, 2)
        lines.append("    }")
        return "\n".join(lines)

    def block(self, node, depth):
        out = []
        for statement in node.children:
            out += self.statement(statement, depth)
        return out

    def statement(self, node, depth):
        pad = "    " * depth
        kind = node.kind
        if kind == "local":
            declared = self.type(node.children[0])
            if len(node.children) > 1:
                return ["%s%s v_%s = %s;" % (pad, declared, node.text, self.expression(node.children[1].children[0]))]
            return ["%s%s v_%s;" % (pad, declared, node.text)]
        if kind == "expr-stmt":
            return [pad + self.expression_statement(node.children[0])]
        if kind == "return":
            return [pad + ("return %s;" % self.expression(node.children[0]) if node.children else "return;")]
        if kind in ("break", "continue"):
            return [pad + kind + ";"]
        if kind in ("if", "while"):
            return ["%s%s (%s) {" % (pad, kind, self.expression(node.children[0]))] + self.block(node.children[1], depth + 1) + [pad + "}"]
        if kind == "for":
            return self.loop(node, depth)
        raise ValueError("unsupported statement " + kind)

    def loop(self, node, depth):
        pad = "    " * depth
        start, condition, update, body = node.children
        if self.contains(body, "continue"):
            raise ValueError("continue inside for is not translated")
        out = [pad + "if (true) {"] + self.statement(start.children[0], depth + 1)
        out.append("%s    while (%s) {" % (pad, self.expression(condition.children[0])))
        out += self.block(body, depth + 2)
        out.append("%s        %s" % (pad, self.expression_statement(update.children[0])))
        return out + [pad + "    }", pad + "}"]

    def contains(self, node, kind):
        return node.kind == kind or any(self.contains(child, kind) for child in node.children)

    def expression_statement(self, node):
        if node.kind == "assign":
            return self.assignment(node) + ";"
        if node.kind == "postfix":
            target = self.expression(node.children[0])
            return "%s = %s %s 1;" % (target, target, node.text[0])
        return self.expression(node) + ";"

    def assignment(self, node):
        target, value = node.children
        operator = node.text[:-1]
        right = self.expression(value)
        if target.kind == "index":
            receiver, index = self.expression(target.children[0]), self.expression(target.children[1])
            if operator:
                right = "(%s.get(%s) %s %s)" % (receiver, index, operator, right)
            return "%s.set(%s, %s)" % (receiver, index, right)
        name = self.expression(target)
        if operator:
            right = "(%s %s %s)" % (name, operator, right)
        return "%s = %s" % (name, right)

    def expression(self, node):
        kind = node.kind
        if kind == "int-literal":
            return node.text
        if kind == "bool-literal":
            return node.text
        if kind == "string":
            return emerald_string(node.text)
        if kind == "name":
            if node.text in self.constants:
                return "(%d)" % self.constants[node.text]
            return "v_" + node.text
        if kind == "unary":
            return "(%s%s)" % (node.text, self.expression(node.children[0]))
        if kind == "binary":
            return "(%s %s %s)" % (self.expression(node.children[0]), node.text, self.expression(node.children[1]))
        if kind == "index":
            return "%s.get(%s)" % (self.expression(node.children[0]), self.expression(node.children[1]))
        if kind == "list-literal":
            self.list_arities.add(len(node.children))
            return "Program.m_list%d(%s)" % (len(node.children), ", ".join(self.expression(c) for c in node.children))
        if kind == "call":
            return self.call(node)
        raise ValueError("unsupported expression " + kind)

    def call(self, node):
        callee, args = node.children[0], [self.expression(c) for c in node.children[1:]]
        if callee.kind == "name":
            return "Program.m_%s(%s)" % (callee.text, ", ".join(args))
        receiver = self.expression(callee.children[0])
        if callee.text == "byteAt":
            return "Program.m_byteAt(%s, %s)" % (receiver, args[0])
        return "%s.%s(%s)" % (receiver, BUILTIN_RENAMES.get(callee.text, callee.text), ", ".join(args))

    def helpers(self):
        out = ['''    public static Int m_byteAt(String v_text, Int v_index) {
        String character = v_text.charAt(v_index).toString();

        if (character == "\\n") {
            return 10;
        }

        if (character == "\\t") {
            return 9;
        }

        if (character == "\\r") {
            return 13;
        }

        return 32 + %s.indexOf(character);
    }''' % emerald_string(ASCII_TABLE)]
        for arity in sorted(self.list_arities):
            params = ", ".join("Int v_item%d" % i for i in range(arity))
            adds = "\n".join("        list.add(v_item%d);" % i for i in range(arity))
            out.append("    public static List<Int> m_list%d(%s) {\n        List<Int> list = List();\n%s\n        return list;\n    }" % (arity, params, adds))
        return out


def main():
    ring0, out_dir, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    dump = subprocess.run([ring0] + files + ["--ast"], capture_output=True, text=True)
    if dump.returncode != 0:
        sys.exit(dump.stdout + dump.stderr)
    translator = Translator(read_tree(dump.stdout))
    os.makedirs(os.path.join(out_dir, "ring1"), exist_ok=True)
    body = "\n\n".join(translator.methods + translator.helpers())
    open(os.path.join(out_dir, "ring1", "Program.ems"), "w").write("namespace ring1;\n\npublic class Program {\n    public Program() {\n    }\n\n" + body + "\n}\n")
    open(os.path.join(out_dir, "Ring1Main.ems"), "w").write('use ring1::Program;\n\nmain() {\n    Int failed = Program.m_main();\n    println("failed cases: " + failed.toString());\n}\n')


main()
