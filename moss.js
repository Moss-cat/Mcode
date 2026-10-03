/**
 * moss.js — MOSS 语言解释器 + 囚徒困境博弈引擎
 *
 * MOSS 是 Python 的变体，专为编写博弈 AI bot 设计。
 * 支持：if/elif/else、while、for...in、def、list/dict/tuple、内置函数与方法
 * 特殊语法：main()（必有）、choose()、win（只读）、delay()、run...when（事件钩子）
 *
 * 沙盒：无 import/open/eval/exec，步数与递归深度限制
 *
 * 用法：
 *   const bot = new MOSS.Bot('myBot', sourceCode);
 *   const choice = bot.decide({ win: false, round: 3, history: [...] });
 *   // choice === 'cooperate' | 'defect' | null（默认 defect）
 *
 *   const arena = new MOSS.Arena({ rounds: 200, mode: '1v1' | 'round-robin' });
 *   arena.addBot('bot1', code1);
 *   arena.addBot('bot2', code2);
 *   const result = arena.runMatch();
 */

(function (global) {
  'use strict';

  // ============================================================
  //  Lexer（词法分析）
  // ============================================================

  const KEYWORDS = new Set([
    'if', 'elif', 'else', 'while', 'for', 'def', 'return',
    'True', 'False', 'None', 'in', 'not', 'and', 'or',
    'pass', 'break', 'continue', 'is'
  ]);

  // 三字符与两字符运算符优先级表
  const THREE_CHAR_OPS = ['**=', '//=', '...'];
  const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '**', '//', '->', '&&', '||'];

  function tokenize(source) {
    const tokens = [];
    const lines = source.split(/\r?\n/);
    const indentStack = [0];
    let parenDepth = 0; // 在括号内时不发 INDENT/DEDENT/NEWLINE

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      let line = lines[lineNum];

      // 注释剥离（# 开头或行中 #，但要避开字符串内 #）
      if (parenDepth === 0) {
        line = stripComment(line);
      }

      // 空行
      if (line.trim() === '') {
        if (parenDepth === 0) tokens.push({ type: 'NEWLINE', line: lineNum + 1 });
        continue;
      }

      // 计算缩进
      let indent = 0;
      let i = 0;
      if (parenDepth === 0) {
        while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
          if (line[i] === ' ') indent++;
          else indent += 4 - (indent % 4);
          i++;
        }

        const top = indentStack[indentStack.length - 1];
        if (indent > top) {
          indentStack.push(indent);
          tokens.push({ type: 'INDENT', line: lineNum + 1 });
        } else {
          while (indent < indentStack[indentStack.length - 1]) {
            indentStack.pop();
            tokens.push({ type: 'DEDENT', line: lineNum + 1 });
          }
          if (indent !== indentStack[indentStack.length - 1]) {
            throw new MOSSParseError(`IndentationError: 行 ${lineNum + 1} 缩进不一致`);
          }
        }
      }

      // 行内 token
      let j = (parenDepth === 0) ? i : 0;
      while (j < line.length) {
        const ch = line[j];
        if (ch === ' ' || ch === '\t') { j++; continue; }

        // 数字字面量（含 .5 浮点）
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[j + 1] || ''))) {
          let num = '';
          while (j < line.length && /[0-9_]/.test(line[j])) { num += line[j]; j++; }
          if (line[j] === '.' && /[0-9]/.test(line[j + 1] || '')) {
            num += '.';
            j++;
            while (j < line.length && /[0-9_]/.test(line[j])) { num += line[j]; j++; }
            tokens.push({ type: 'NUMBER', value: parseFloat(num.replace(/_/g, '')), line: lineNum + 1 });
          } else if (line[j] === 'e' || line[j] === 'E') {
            // 科学计数法
            num += line[j]; j++;
            if (line[j] === '+' || line[j] === '-') { num += line[j]; j++; }
            while (j < line.length && /[0-9]/.test(line[j])) { num += line[j]; j++; }
            tokens.push({ type: 'NUMBER', value: parseFloat(num.replace(/_/g, '')), line: lineNum + 1 });
          } else {
            tokens.push({ type: 'NUMBER', value: parseInt(num.replace(/_/g, ''), 10), line: lineNum + 1 });
          }
          continue;
        }

        // 字符串字面量
        if (ch === '"' || ch === "'") {
          const quote = ch;
          let str = '';
          j++;
          while (j < line.length && line[j] !== quote) {
            if (line[j] === '\\' && j + 1 < line.length) {
              const next = line[j + 1];
              if (next === 'n') str += '\n';
              else if (next === 't') str += '\t';
              else if (next === 'r') str += '\r';
              else if (next === quote) str += quote;
              else if (next === '\\') str += '\\';
              else str += next;
              j += 2;
            } else {
              str += line[j];
              j++;
            }
          }
          if (j >= line.length) {
            throw new MOSSParseError(`SyntaxError: 行 ${lineNum + 1} 字符串未闭合`);
          }
          j++;
          tokens.push({ type: 'STRING', value: str, line: lineNum + 1 });
          continue;
        }

        // 标识符 / 关键字
        if (/[a-zA-Z_]/.test(ch)) {
          let name = '';
          while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) { name += line[j]; j++; }
          tokens.push({
            type: KEYWORDS.has(name) ? 'KEYWORD' : 'NAME',
            value: name,
            line: lineNum + 1
          });
          continue;
        }

        // 三字符运算符
        const three = line.slice(j, j + 3);
        if (THREE_CHAR_OPS.includes(three)) {
          tokens.push({ type: 'OP', value: three, line: lineNum + 1 });
          j += 3;
          continue;
        }

        // 两字符运算符
        const two = line.slice(j, j + 2);
        if (TWO_CHAR_OPS.includes(two)) {
          // && || 转成 Python 风格
          let val = two;
          if (val === '&&') val = 'and';
          if (val === '||') val = 'or';
          tokens.push({ type: val === 'and' || val === 'or' ? 'KEYWORD' : 'OP', value: val, line: lineNum + 1 });
          j += 2;
          continue;
        }

        // 单字符运算符 / 分隔符
        if ('+-*/%=<>(),:.[]!'.includes(ch)) {
          if (ch === '(' || ch === '[' || ch === '{') parenDepth++;
          if (ch === ')' || ch === ']' || ch === '}') parenDepth = Math.max(0, parenDepth - 1);
          tokens.push({ type: 'OP', value: ch, line: lineNum + 1 });
          j++;
          continue;
        }

        throw new MOSSParseError(`SyntaxError: 行 ${lineNum + 1} 未知字符 '${ch}'`);
      }

      if (parenDepth === 0) {
        tokens.push({ type: 'NEWLINE', line: lineNum + 1 });
      }
    }

    // 文件末尾收尾
    while (indentStack.length > 1) {
      indentStack.pop();
      tokens.push({ type: 'DEDENT', line: lines.length });
    }
    tokens.push({ type: 'EOF', line: lines.length });

    return tokens;
  }

  function stripComment(line) {
    let inStr = false, quote = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) inStr = false;
      } else {
        if (ch === '"' || ch === "'") { inStr = true; quote = ch; }
        else if (ch === '#') return line.slice(0, i);
      }
    }
    return line;
  }

  // ============================================================
  //  Parser（递归下降）
  // ============================================================

  function MOSSParseError(msg) {
    this.name = 'MOSSParseError';
    this.message = msg;
    this.toString = () => `${this.name}: ${this.message}`;
  }
  MOSSParseError.prototype = Object.create(Error.prototype);

  class Parser {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
    }

    peek(off = 0) {
      return this.tokens[this.pos + off] || { type: 'EOF' };
    }

    next() {
      return this.tokens[this.pos++];
    }

    expect(type, value) {
      const t = this.next();
      if (t.type !== type || (value !== undefined && t.value !== value)) {
        throw new MOSSParseError(`SyntaxError: 行 ${t.line} 期望 ${type}${value ? ' "' + value + '"' : ''}, 实际 ${t.type} ${t.value || ''}`);
      }
      return t;
    }

    match(type, value) {
      const t = this.peek();
      if (t.type === type && (value === undefined || t.value === value)) {
        this.pos++;
        return true;
      }
      return false;
    }

    eatNewlines() {
      while (this.peek().type === 'NEWLINE') this.pos++;
    }

    parse() {
      const body = [];
      this.eatNewlines();
      while (this.peek().type !== 'EOF') {
        body.push(this.statement());
        this.eatNewlines();
      }
      return { type: 'Module', body };
    }

    // -------- 语句 --------

    statement() {
      const t = this.peek();

      if (t.type === 'KEYWORD') {
        if (t.value === 'if') return this.ifStmt();
        if (t.value === 'while') return this.whileStmt();
        if (t.value === 'for') return this.forStmt();
        if (t.value === 'def') return this.defStmt();
        if (t.value === 'return') return this.returnStmt();
        if (t.value === 'pass') { this.pos++; this.match('NEWLINE'); return { type: 'Pass' }; }
        if (t.value === 'break') { this.pos++; this.match('NEWLINE'); return { type: 'Break' }; }
        if (t.value === 'continue') { this.pos++; this.match('NEWLINE'); return { type: 'Continue' }; }
      }

      // run "func" when condition:  事件钩子
      if (t.type === 'NAME' && t.value === 'run' && this.peek(1).type === 'STRING') {
        return this.runWhenStmt();
      }

      return this.simpleStmt();
    }

    ifStmt() {
      this.expect('KEYWORD', 'if');
      const test = this.expr();
      this.expect('OP', ':');
      const body = this.block();
      const node = { type: 'If', test, body, orelse: [] };
      let cur = node;

      while (this.peek().type === 'KEYWORD' && this.peek().value === 'elif') {
        this.pos++;
        const t2 = this.expr();
        this.expect('OP', ':');
        const b2 = this.block();
        const next = { type: 'If', test: t2, body: b2, orelse: [] };
        cur.orelse = [next];
        cur = next;
      }

      if (this.peek().type === 'KEYWORD' && this.peek().value === 'else') {
        this.pos++;
        this.expect('OP', ':');
        cur.orelse = this.block();
      }

      return node;
    }

    whileStmt() {
      this.expect('KEYWORD', 'while');
      const test = this.expr();
      this.expect('OP', ':');
      const body = this.block();
      return { type: 'While', test, body };
    }

    forStmt() {
      this.expect('KEYWORD', 'for');
      const target = this.expect('NAME').value;
      this.expect('KEYWORD', 'in');
      const iter = this.expr();
      this.expect('OP', ':');
      const body = this.block();
      return { type: 'For', target, iter, body };
    }

    defStmt() {
      this.expect('KEYWORD', 'def');
      const name = this.expect('NAME').value;
      this.expect('OP', '(');
      const params = [];
      if (this.peek().type !== 'OP' || this.peek().value !== ')') {
        do {
          params.push(this.expect('NAME').value);
        } while (this.match('OP', ','));
      }
      this.expect('OP', ')');
      this.expect('OP', ':');
      const body = this.block();
      return { type: 'FunctionDef', name, params, body };
    }

    returnStmt() {
      this.expect('KEYWORD', 'return');
      if (this.peek().type === 'NEWLINE' || this.peek().type === 'EOF') {
        this.match('NEWLINE');
        return { type: 'Return', value: null };
      }
      const value = this.expr();
      this.match('NEWLINE');
      return { type: 'Return', value };
    }

    runWhenStmt() {
      this.expect('NAME', 'run');
      const eventTok = this.expect('STRING');
      this.expect('NAME', 'when');
      const test = this.expr();
      this.expect('OP', ':');
      const body = this.block();
      return { type: 'RunWhen', event: eventTok.value, test, body };
    }

    simpleStmt() {
      // 表达式语句 / 赋值 / 增量赋值
      const expr = this.expr();

      if (this.peek().type === 'OP' &&
        ['=', '+=', '-=', '*=', '/=', '%=', '**=', '//='].includes(this.peek().value)) {
        const op = this.next().value;
        const value = this.expr();
        this.match('NEWLINE');
        if (op === '=') return { type: 'Assign', target: expr, value };
        return { type: 'AugAssign', op, target: expr, value };
      }

      this.match('NEWLINE');
      return { type: 'Expr', value: expr };
    }

    block() {
      // block → NEWLINE INDENT statement+ DEDENT | simple_stmt
      const stmts = [];

      if (this.peek().type === 'OP' && this.peek().value === ';') {
        // 单行 block: a; b; c
        this.pos++;
        // 实际上 : 后跟单行表达式（简化）
      }

      if (this.peek().type === 'NEWLINE') {
        this.expect('NEWLINE');
        this.eatNewlines();
        this.expect('INDENT');
        while (this.peek().type !== 'DEDENT' && this.peek().type !== 'EOF') {
          stmts.push(this.statement());
          this.eatNewlines();
        }
        this.match('DEDENT');
      } else {
        // 单行 block
        stmts.push(this.statement());
      }

      return stmts;
    }

    // -------- 表达式 --------

    expr() {
      return this.ternary();
    }

    ternary() {
      const or = this.orExpr();
      if (this.peek().type === 'KEYWORD' && this.peek().value === 'if') {
        // a if cond else b
        this.pos++;
        const cond = this.orExpr();
        this.expect('KEYWORD', 'else');
        const els = this.ternary();
        return { type: 'IfExp', body: or, test: cond, orelse: els };
      }
      return or;
    }

    orExpr() {
      let left = this.andExpr();
      while (this.peek().type === 'KEYWORD' && this.peek().value === 'or') {
        this.pos++;
        const right = this.andExpr();
        left = { type: 'BoolOp', op: 'or', left, right };
      }
      return left;
    }

    andExpr() {
      let left = this.notExpr();
      while (this.peek().type === 'KEYWORD' && this.peek().value === 'and') {
        this.pos++;
        const right = this.notExpr();
        left = { type: 'BoolOp', op: 'and', left, right };
      }
      return left;
    }

    notExpr() {
      if (this.peek().type === 'KEYWORD' && this.peek().value === 'not') {
        this.pos++;
        return { type: 'UnaryOp', op: 'not', operand: this.notExpr() };
      }
      return this.comparison();
    }

    comparison() {
      let left = this.arith();
      while (this.peek().type === 'OP' &&
        ['==', '!=', '<', '>', '<=', '>='].includes(this.peek().value) ||
        (this.peek().type === 'KEYWORD' && (this.peek().value === 'in' || this.peek().value === 'is'))) {

        let op = this.next().value;
        let isNot = false;
        if (this.peek().type === 'KEYWORD' && this.peek().value === 'not') {
          // not in
          this.pos++;
          isNot = true;
          op = 'not in';
        }
        const right = this.arith();
        left = { type: 'Compare', op, left, right };
        if (isNot) left = { type: 'UnaryOp', op: 'not', operand: left };
      }
      return left;
    }

    arith() {
      let left = this.term();
      while (this.peek().type === 'OP' && ['+', '-'].includes(this.peek().value)) {
        const op = this.next().value;
        const right = this.term();
        left = { type: 'BinOp', op, left, right };
      }
      return left;
    }

    term() {
      let left = this.factor();
      while (this.peek().type === 'OP' && ['*', '/', '%', '//'].includes(this.peek().value)) {
        const op = this.next().value;
        const right = this.factor();
        left = { type: 'BinOp', op, left, right };
      }
      return left;
    }

    factor() {
      if (this.peek().type === 'OP' && (this.peek().value === '-' || this.peek().value === '+')) {
        const op = this.next().value;
        return { type: 'UnaryOp', op, operand: this.factor() };
      }
      return this.power();
    }

    power() {
      let left = this.atom();
      if (this.peek().type === 'OP' && this.peek().value === '**') {
        this.pos++;
        const right = this.factor();
        left = { type: 'BinOp', op: '**', left, right };
      }
      return left;
    }

    atom() {
      const t = this.peek();

      if (t.type === 'NUMBER') { this.pos++; return { type: 'Num', value: t.value }; }
      if (t.type === 'STRING') {
        // 字符串拼接（相邻字符串）
        let s = t.value;
        this.pos++;
        while (this.peek().type === 'STRING') { s += this.next().value; }
        return { type: 'Str', value: s };
      }
      if (t.type === 'KEYWORD') {
        if (t.value === 'True') { this.pos++; return { type: 'Bool', value: true }; }
        if (t.value === 'False') { this.pos++; return { type: 'Bool', value: false }; }
        if (t.value === 'None') { this.pos++; return { type: 'None' }; }
      }
      if (t.type === 'NAME') {
        this.pos++;
        let node = { type: 'Name', id: t.value };

        // 后缀：调用、索引、属性
        while (true) {
          const p = this.peek();
          if (p.type === 'OP' && p.value === '(') {
            this.pos++;
            const args = [];
            const kwargs = [];
            if (this.peek().type !== 'OP' || this.peek().value !== ')') {
              do {
                // 检测关键字参数 name=expr
                if (this.peek().type === 'NAME' && this.peek(1).type === 'OP' && this.peek(1).value === '=') {
                  const kname = this.next().value;
                  this.next(); // =
                  const kval = this.expr();
                  kwargs.push({ name: kname, value: kval });
                } else {
                  args.push(this.expr());
                }
              } while (this.match('OP', ','));
            }
            this.expect('OP', ')');
            node = { type: 'Call', func: node, args, kwargs };
          } else if (p.type === 'OP' && (p.value === '[' || p.value === '.' )) {
            if (p.value === '[') {
              this.pos++;
              const idx = this.expr();
              // 切片支持简化：a[1:3]
              if (this.peek().type === 'OP' && this.peek().value === ':') {
                this.pos++;
                let upper = null;
                if (this.peek().type !== 'OP' || this.peek().value !== ']') {
                  upper = this.expr();
                }
                this.expect('OP', ']');
                node = { type: 'Slice', obj: node, lower: idx, upper };
              } else {
                this.expect('OP', ']');
                node = { type: 'Index', obj: node, index: idx };
              }
            } else {
              // .attr
              this.pos++;
              const attr = this.expect('NAME').value;
              node = { type: 'Attr', obj: node, attr };
            }
          } else {
            break;
          }
        }
        return node;
      }

      if (t.type === 'OP') {
        if (t.value === '(') {
          this.pos++;
          const e = this.expr();
          // 检测元组 (a, b, c)
          if (this.peek().type === 'OP' && this.peek().value === ',') {
            const elts = [e];
            while (this.match('OP', ',')) {
              if (this.peek().type === 'OP' && this.peek().value === ')') break;
              elts.push(this.expr());
            }
            this.expect('OP', ')');
            return { type: 'Tuple', elts };
          }
          this.expect('OP', ')');
          return e;
        }
        if (t.value === '[') {
          this.pos++;
          const elts = [];
          while (this.peek().type !== 'OP' || this.peek().value !== ']') {
            elts.push(this.expr());
            if (!this.match('OP', ',')) break;
          }
          this.expect('OP', ']');
          return { type: 'List', elts };
        }
        if (t.value === '{') {
          this.pos++;
          const keys = [];
          const values = [];
          if (this.peek().type !== 'OP' || this.peek().value !== '}') {
            do {
              const k = this.expr();
              this.expect('OP', ':');
              const v = this.expr();
              keys.push(k);
              values.push(v);
            } while (this.match('OP', ','));
          }
          this.expect('OP', '}');
          return { type: 'Dict', keys, values };
        }
      }

      throw new MOSSParseError(`SyntaxError: 行 ${t.line} 意外 token ${t.type} ${t.value || ''}`);
    }
  }

  // ============================================================
  //  Interpreter（树遍历）
  // ============================================================

  class MOSSRuntimeError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'MOSSRuntimeError';
    }
  }

  // 用于 break/continue/return 的控制流信号
  class FlowSignal { constructor(type, value) { this.type = type; this.value = value; } }

  class Scope {
    constructor(parent = null) {
      this.vars = Object.create(parent ? parent.vars : null);
      this.parent = parent;
    }
    get(name) {
      if (!(name in this.vars)) throw new MOSSRuntimeError(`NameError: 名字 '${name}' 未定义`);
      return this.vars[name];
    }
    set(name, value) { this.vars[name] = value; }
    has(name) { return name in this.vars; }
  }

  class Interpreter {
    constructor(ast, botApi) {
      this.ast = ast;
      this.botApi = botApi; // { choose, delay, getWin, getRound, getHistory }
      this.globals = new Scope();
      this.functions = {};
      this.eventHooks = []; // [{event, test, body}]
      this.steps = 0;
      this.maxSteps = 100000;
      this.maxDepth = 200;
      this.depth = 0;

      this._setupBuiltins();
    }

    _setupBuiltins() {
      const g = this.globals;

      const makeBuiltin = (fn) => ({ __builtin: true, fn });

      g.set('len', makeBuiltin(x => {
        if (x === null || x === undefined) throw new MOSSRuntimeError('TypeError: len() 参数不能为空');
        if (typeof x === 'string' || Array.isArray(x)) return x.length;
        if (x instanceof MossDict) return x.size();
        throw new MOSSRuntimeError('TypeError: 对象没有 len()');
      }));

      g.set('range', makeBuiltin((...args) => {
        let start = 0, stop = 0, step = 1;
        if (args.length === 1) stop = args[0];
        else if (args.length === 2) { start = args[0]; stop = args[1]; }
        else if (args.length === 3) { start = args[0]; stop = args[1]; step = args[2]; }
        if (step === 0) throw new MOSSRuntimeError('ValueError: range() 步长不能为 0');
        const arr = [];
        if (step > 0) for (let i = start; i < stop; i += step) arr.push(i);
        else for (let i = start; i > stop; i += step) arr.push(i);
        return arr;
      }));

      g.set('print', makeBuiltin((...args) => {
        const s = args.map(a => pyRepr(a)).join(' ');
        this.botApi.log(s);
        return null;
      }));

      g.set('str', makeBuiltin(x => x === null || x === undefined ? 'None' : pyRepr(x)));
      g.set('int', makeBuiltin(x => {
        if (typeof x === 'string') {
          const n = parseInt(x, 10);
          if (isNaN(n)) throw new MOSSRuntimeError(`ValueError: 无法将 '${x}' 转换为 int`);
          return n;
        }
        return Math.trunc(Number(x));
      }));
      g.set('float', makeBuiltin(x => {
        if (typeof x === 'string') {
          const n = parseFloat(x);
          if (isNaN(n)) throw new MOSSRuntimeError(`ValueError: 无法将 '${x}' 转换为 float`);
          return n;
        }
        return Number(x);
      }));
      g.set('bool', makeBuiltin(x => isTruthy(x)));
      g.set('list', makeBuiltin(x => {
        if (x === null || x === undefined) return [];
        if (Array.isArray(x)) return x.slice();
        if (typeof x === 'string') return x.split('');
        if (x instanceof MossDict) return x.itemsArray().map(kv => [kv[0], kv[1]]);
        throw new MOSSRuntimeError('TypeError: 无法转换为 list');
      }));
      g.set('dict', makeBuiltin(x => {
        const d = new MossDict();
        if (x && Array.isArray(x)) {
          for (const kv of x) {
            if (!Array.isArray(kv) || kv.length !== 2) throw new MOSSRuntimeError('dict() 参数必须是 (key, value) 对');
            d.set(kv[0], kv[1]);
          }
        }
        return d;
      }));
      g.set('tuple', makeBuiltin(x => {
        if (x === null || x === undefined) return new MossTuple([]);
        if (Array.isArray(x)) return new MossTuple(x.slice());
        throw new MOSSRuntimeError('TypeError: 无法转换为 tuple');
      }));
      g.set('abs', makeBuiltin(x => Math.abs(Number(x))));
      g.set('min', makeBuiltin((...args) => {
        const arr = args.length === 1 ? args[0] : args;
        if (!Array.isArray(arr) || arr.length === 0) throw new MOSSRuntimeError('min() 参数为空');
        let m = arr[0];
        for (const v of arr) if (pyLessThan(v, m)) m = v;
        return m;
      }));
      g.set('max', makeBuiltin((...args) => {
        const arr = args.length === 1 ? args[0] : args;
        if (!Array.isArray(arr) || arr.length === 0) throw new MOSSRuntimeError('max() 参数为空');
        let m = arr[0];
        for (const v of arr) if (pyGreaterThan(v, m)) m = v;
        return m;
      }));
      g.set('sum', makeBuiltin((arr, start) => {
        let s = start === undefined ? 0 : start;
        if (!Array.isArray(arr)) throw new MOSSRuntimeError('sum() 参数必须是可迭代对象');
        for (const v of arr) s = pyAdd(s, v);
        return s;
      }));
      g.set('sorted', makeBuiltin((arr, opts) => {
        const a = Array.isArray(arr) ? arr.slice() : [];
        // 简化：只支持数字、字符串排序
        a.sort((x, y) => {
          if (pyLessThan(x, y)) return -1;
          if (pyGreaterThan(x, y)) return 1;
          return 0;
        });
        if (opts && opts.reverse) a.reverse();
        return a;
      }));
      g.set('enumerate', makeBuiltin((arr, start) => {
        const s = start === undefined ? 0 : start;
        return arr.map((v, i) => [s + i, v]);
      }));
      g.set('zip', makeBuiltin((...arrs) => {
        if (arrs.length === 0) return [];
        const minLen = Math.min(...arrs.map(a => a.length || 0));
        const out = [];
        for (let i = 0; i < minLen; i++) out.push(arrs.map(a => a[i]));
        return out;
      }));
      // 四舍五入函数（注意：变量 round 是只读的当前轮数，所以函数改名 rround）
      g.set('rround', makeBuiltin((x, n) => {
        const factor = n ? Math.pow(10, n) : 1;
        return Math.round(x * factor) / factor;
      }));

      // 随机数函数（沙盒内用 Math.random，不可预测但足够博弈用）
      g.set('random', makeBuiltin(() => Math.random()));
      g.set('randint', makeBuiltin((a, b) => {
        const lo = Math.ceil(Number(a));
        const hi = Math.floor(Number(b));
        if (lo > hi) throw new MOSSRuntimeError('ValueError: randint(a, b) 要求 a <= b');
        return Math.floor(Math.random() * (hi - lo + 1)) + lo;
      }));
      g.set('choice', makeBuiltin((arr) => {
        if (!Array.isArray(arr) || arr.length === 0) throw new MOSSRuntimeError('ValueError: choice() 参数必须是非空列表');
        return arr[Math.floor(Math.random() * arr.length)];
      }));

      // 注入只读变量 win（在 decide 时再覆盖）
      g.set('win', false);
      g.set('round', 0);
      g.set('history', []);
      g.set('opponent_history', []);
    }

    run() {
      this._executeModule(this.ast);
    }

    _executeModule(node) {
      // 收集函数定义与事件钩子
      for (const stmt of node.body) {
        if (stmt.type === 'FunctionDef') {
          this.functions[stmt.name] = stmt;
          this.globals.set(stmt.name, { __userfn: true, def: stmt });
        } else if (stmt.type === 'RunWhen') {
          this.eventHooks.push(stmt);
        } else if (stmt.type === 'Expr' && stmt.value.type === 'Call') {
          // 顶层调用：执行（如 main() 的定义已收集，调用由引擎处理）
          // 这里只执行非 main 的顶层表达式调用
          if (stmt.value.func.type === 'Name' && stmt.value.func.id === 'main') {
            // 顶层 main() 调用由引擎调用，源码里直接跳过
          } else {
            this._execStatement(stmt, this.globals);
          }
        } else if (stmt.type !== 'FunctionDef' && stmt.type !== 'RunWhen') {
          // 其他顶层语句（赋值等）执行
          this._execStatement(stmt, this.globals);
        }
      }
    }

    // 执行 main() 取决策
    decide() {
      // 评估事件钩子
      for (const hook of this.eventHooks) {
        try {
          if (isTruthy(this._evalExpr(hook.test, this.globals))) {
            this._execBlock(hook.body, this.globals);
          }
        } catch (e) {
          if (!(e instanceof MOSSRuntimeError)) throw e;
          this.botApi.log('事件钩子错误: ' + e.message);
        }
      }

      // 调用 main()
      if (!this.functions['main']) {
        throw new MOSSRuntimeError('NameError: 程序必须定义 main() 函数');
      }
      const result = this._callFunction('main', [], this.globals);
      return result;
    }

    _callFunction(name, args, callerScope) {
      const fn = this.functions[name];
      if (!fn) throw new MOSSRuntimeError(`NameError: 函数 '${name}' 未定义`);

      this.depth++;
      if (this.depth > this.maxDepth) {
        throw new MOSSRuntimeError('RecursionError: 超过最大递归深度');
      }

      const local = new Scope(this.globals);
      for (let i = 0; i < fn.params.length; i++) {
        local.set(fn.params[i], args[i] !== undefined ? args[i] : null);
      }

      let result = null;
      try {
        for (const stmt of fn.body) {
          const sig = this._execStatement(stmt, local);
          if (sig instanceof FlowSignal && sig.type === 'return') {
            result = sig.value;
            break;
          }
        }
      } finally {
        this.depth--;
      }
      return result;
    }

    _execBlock(stmts, scope) {
      for (const stmt of stmts) {
        const sig = this._execStatement(stmt, scope);
        if (sig instanceof FlowSignal) return sig;
      }
      return null;
    }

    _execStatement(node, scope) {
      this.steps++;
      if (this.steps > this.maxSteps) {
        throw new MOSSRuntimeError('RuntimeError: 超过最大执行步数（可能死循环）');
      }

      switch (node.type) {
        case 'Pass': return null;
        case 'Break': return new FlowSignal('break');
        case 'Continue': return new FlowSignal('continue');

        case 'Expr':
          this._evalExpr(node.value, scope);
          return null;

        case 'Assign': {
          const val = this._evalExpr(node.value, scope);
          this._assign(node.target, val, scope);
          return null;
        }

        case 'AugAssign': {
          const cur = this._evalExpr(node.target, scope);
          const rhs = this._evalExpr(node.value, scope);
          const newVal = pyBinOp(node.op, cur, rhs);
          this._assign(node.target, newVal, scope);
          return null;
        }

        case 'Return':
          return new FlowSignal('return', node.value ? this._evalExpr(node.value, scope) : null);

        case 'If': {
          if (isTruthy(this._evalExpr(node.test, scope))) {
            return this._execBlock(node.body, scope);
          }
          for (const stmt of node.body) { /* noop */ }
          if (node.orelse && node.orelse.length) {
            return this._execBlock(node.orelse, scope);
          }
          return null;
        }

        case 'While': {
          while (isTruthy(this._evalExpr(node.test, scope))) {
            const sig = this._execBlock(node.body, scope);
            if (sig instanceof FlowSignal) {
              if (sig.type === 'break') break;
              if (sig.type === 'continue') continue;
              if (sig.type === 'return') return sig;
            }
          }
          return null;
        }

        case 'For': {
          const iter = this._evalExpr(node.iter, scope);
          const items = pyIter(iter);
          for (const item of items) {
            scope.set(node.target, item);
            const sig = this._execBlock(node.body, scope);
            if (sig instanceof FlowSignal) {
              if (sig.type === 'break') break;
              if (sig.type === 'continue') continue;
              if (sig.type === 'return') return sig;
            }
          }
          return null;
        }

        case 'FunctionDef': {
          this.functions[node.name] = node;
          scope.set(node.name, { __userfn: true, def: node });
          return null;
        }

        case 'RunWhen': {
          this.eventHooks.push(node);
          return null;
        }

        default:
          throw new MOSSRuntimeError(`RuntimeError: 未知语句类型 ${node.type}`);
      }
    }

    _assign(target, val, scope) {
      if (target.type === 'Name') {
        // 只读变量保护
        if (target.id === 'win' || target.id === 'round' || target.id === 'history' || target.id === 'opponent_history') {
          throw new MOSSRuntimeError(`PermissionError: '${target.id}' 是只读变量，不能赋值`);
        }
        scope.set(target.id, val);
      } else if (target.type === 'Index') {
        const obj = this._evalExpr(target.obj, scope);
        const idx = this._evalExpr(target.index, scope);
        if (Array.isArray(obj)) {
          const i = idx < 0 ? obj.length + idx : idx;
          obj[i] = val;
        } else if (obj instanceof MossDict) {
          obj.set(idx, val);
        } else {
          throw new MOSSRuntimeError('TypeError: 该对象不支持索引赋值');
        }
      } else if (target.type === 'Attr') {
        // 简化：暂不支持属性赋值
        throw new MOSSRuntimeError('SyntaxError: 暂不支持属性赋值');
      } else {
        throw new MOSSRuntimeError('SyntaxError: 无效赋值目标');
      }
    }

    _evalExpr(node, scope) {
      this.steps++;
      if (this.steps > this.maxSteps) {
        throw new MOSSRuntimeError('RuntimeError: 超过最大执行步数（可能死循环）');
      }

      switch (node.type) {
        case 'Num': return node.value;
        case 'Str': return node.value;
        case 'Bool': return node.value;
        case 'None': return null;

        case 'Name': {
          if (node.id === 'win') return this.botApi.getWin();
          if (node.id === 'round') return this.botApi.getRound();
          if (node.id === 'history') return this.botApi.getHistory();
          if (node.id === 'opponent_history') return this.botApi.getOpponentHistory();
          if (node.id === 'delay') return { __builtin: true, fn: (s) => { this.botApi.delay(s); return null; } };
          if (node.id === 'choose') return { __builtin: true, fn: (opt) => { this.botApi.choose(opt); return null; } };
          return scope.get(node.id);
        }

        case 'List': return node.elts.map(e => this._evalExpr(e, scope));
        case 'Tuple': return new MossTuple(node.elts.map(e => this._evalExpr(e, scope)));
        case 'Dict': {
          const d = new MossDict();
          for (let i = 0; i < node.keys.length; i++) {
            d.set(this._evalExpr(node.keys[i], scope), this._evalExpr(node.values[i], scope));
          }
          return d;
        }

        case 'BinOp': {
          const l = this._evalExpr(node.left, scope);
          const r = this._evalExpr(node.right, scope);
          return pyBinOp(node.op, l, r);
        }

        case 'UnaryOp': {
          const v = this._evalExpr(node.operand, scope);
          if (node.op === 'not') return !isTruthy(v);
          if (node.op === '-') return -Number(v);
          if (node.op === '+') return +Number(v);
          throw new MOSSRuntimeError(`RuntimeError: 未知一元运算 ${node.op}`);
        }

        case 'BoolOp': {
          const l = this._evalExpr(node.left, scope);
          if (node.op === 'and') {
            if (!isTruthy(l)) return l;
            return this._evalExpr(node.right, scope);
          }
          if (node.op === 'or') {
            if (isTruthy(l)) return l;
            return this._evalExpr(node.right, scope);
          }
          throw new MOSSRuntimeError(`RuntimeError: 未知布尔运算 ${node.op}`);
        }

        case 'Compare': {
          const l = this._evalExpr(node.left, scope);
          const r = this._evalExpr(node.right, scope);
          return pyCompare(node.op, l, r);
        }

        case 'IfExp': {
          return isTruthy(this._evalExpr(node.test, scope))
            ? this._evalExpr(node.body, scope)
            : this._evalExpr(node.orelse, scope);
        }

        case 'Call': {
          const fn = this._evalExpr(node.func, scope);

          // 用户自定义函数
          if (fn && fn.__userfn) {
            const args = node.args.map(a => this._evalExpr(a, scope));
            // 找到函数名
            const fname = node.func.type === 'Name' ? node.func.id : null;
            if (fname) {
              return this._callFunction(fname, args, scope);
            }
            // 通过引用调用
            return this._callUserFn(fn.def, args);
          }

          // 内置函数
          if (fn && fn.__builtin) {
            const args = node.args.map(a => this._evalExpr(a, scope));
            // 处理关键字参数
            const kwargs = {};
            for (const kw of node.kwargs) {
              kwargs[kw.name] = this._evalExpr(kw.value, scope);
            }
            if (Object.keys(kwargs).length > 0) {
              args.push(kwargs);
            }
            return fn.fn(...args);
          }

          throw new MOSSRuntimeError('TypeError: 对象不可调用');
        }

        case 'Index': {
          const obj = this._evalExpr(node.obj, scope);
          const idx = this._evalExpr(node.index, scope);
          if (typeof obj === 'string') {
            const i = idx < 0 ? obj.length + idx : idx;
            if (i < 0 || i >= obj.length) throw new MOSSRuntimeError('IndexError: 字符串索引越界');
            return obj[i];
          }
          if (Array.isArray(obj)) {
            const i = idx < 0 ? obj.length + idx : idx;
            if (i < 0 || i >= obj.length) throw new MOSSRuntimeError('IndexError: 列表索引越界');
            return obj[i];
          }
          if (obj instanceof MossDict) return obj.get(idx);
          if (obj instanceof MossTuple) {
            const i = idx < 0 ? obj.items.length + idx : idx;
            if (i < 0 || i >= obj.items.length) throw new MOSSRuntimeError('IndexError: 元组索引越界');
            return obj.items[i];
          }
          throw new MOSSRuntimeError('TypeError: 该对象不支持索引');
        }

        case 'Slice': {
          const obj = this._evalExpr(node.obj, scope);
          const lo = node.lower ? this._evalExpr(node.lower, scope) : 0;
          const hi = node.upper !== null ? this._evalExpr(node.upper, scope) : (obj && obj.length);
          if (typeof obj === 'string') return obj.slice(lo, hi);
          if (Array.isArray(obj)) return obj.slice(lo, hi);
          if (obj instanceof MossTuple) return new MossTuple(obj.items.slice(lo, hi));
          throw new MOSSRuntimeError('TypeError: 该对象不支持切片');
        }

        case 'Attr': {
          const obj = this._evalExpr(node.obj, scope);
          return getMethod(obj, node.attr, this);
        }

        default:
          throw new MOSSRuntimeError(`RuntimeError: 未知表达式类型 ${node.type}`);
      }
    }

    _callUserFn(def, args) {
      this.depth++;
      if (this.depth > this.maxDepth) throw new MOSSRuntimeError('RecursionError: 超过最大递归深度');
      const local = new Scope(this.globals);
      for (let i = 0; i < def.params.length; i++) {
        local.set(def.params[i], args[i] !== undefined ? args[i] : null);
      }
      let result = null;
      try {
        for (const stmt of def.body) {
          const sig = this._execStatement(stmt, local);
          if (sig instanceof FlowSignal && sig.type === 'return') {
            result = sig.value;
            break;
          }
        }
      } finally {
        this.depth--;
      }
      return result;
    }
  }

  // ============================================================
  //  辅助类型与函数
  // ============================================================

  class MossDict {
    constructor() { this._map = new Map(); }
    set(k, v) {
      const key = typeof k === 'object' ? JSON.stringify(k) : k;
      this._map.set(key, v);
      // 保留原始 key 用于 items()
      if (!this._rawKeys) this._rawKeys = new Map();
      this._rawKeys.set(key, k);
    }
    get(k) {
      const key = typeof k === 'object' ? JSON.stringify(k) : k;
      if (!this._map.has(key)) throw new MOSSRuntimeError(`KeyError: '${k}'`);
      return this._map.get(key);
    }
    has(k) {
      const key = typeof k === 'object' ? JSON.stringify(k) : k;
      return this._map.has(key);
    }
    size() { return this._map.size; }
    keysArray() { return Array.from(this._map.keys()); }
    valuesArray() { return Array.from(this._map.values()); }
    itemsArray() {
      const out = [];
      for (const [k, v] of this._map.entries()) {
        out.push([this._rawKeys ? this._rawKeys.get(k) : k, v]);
      }
      return out;
    }
    // 迭代用：返回 keys 列表
    [Symbol.iterator]() {
      let idx = 0;
      const keys = this.itemsArray();
      return {
        next: () => idx < keys.length
          ? { value: keys[idx++][0], done: false }
          : { done: true }
      };
    }
  }

  class MossTuple {
    constructor(items) { this.items = items; }
    get length() { return this.items.length; }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }

  function pyRepr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return '[' + v.map(pyReprElem).join(', ') + ']';
    if (v instanceof MossTuple) return '(' + v.items.map(pyReprElem).join(', ') + (v.items.length === 1 ? ',' : '') + ')';
    if (v instanceof MossDict) return '{' + v.itemsArray().map(kv => pyReprElem(kv[0]) + ': ' + pyReprElem(kv[1])).join(', ') + '}';
    if (v && v.__builtin) return '<built-in function>';
    if (v && v.__userfn) return '<function>';
    return String(v);
  }
  function pyReprElem(v) {
    if (typeof v === 'string') return "'" + v + "'";
    return pyRepr(v);
  }

  function isTruthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof MossTuple) return v.items.length > 0;
    if (v instanceof MossDict) return v.size() > 0;
    return true;
  }

  function pyIter(v) {
    if (v === null || v === undefined) throw new MOSSRuntimeError('TypeError: 不能迭代 None');
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split('');
    if (v instanceof MossTuple) return v.items;
    if (v instanceof MossDict) return v.itemsArray().map(kv => kv[0]);
    if (typeof v === 'number') throw new MOSSRuntimeError('TypeError: 不能迭代数字');
    throw new MOSSRuntimeError('TypeError: 不能迭代该对象');
  }

  function pyBinOp(op, l, r) {
    switch (op) {
      case '+': return pyAdd(l, r);
      case '-': return Number(l) - Number(r);
      case '*': return Number(l) * Number(r);
      case '/': return Number(l) / Number(r);
      case '%': return Number(l) % Number(r);
      case '//': return Math.floor(Number(l) / Number(r));
      case '**': return Math.pow(Number(l), Number(r));
      default: throw new MOSSRuntimeError(`RuntimeError: 未知运算 ${op}`);
    }
  }

  function pyAdd(l, r) {
    if (typeof l === 'string' || typeof r === 'string') {
      if (typeof l !== typeof r) throw new MOSSRuntimeError('TypeError: 字符串只能与字符串拼接');
      return l + r;
    }
    if (Array.isArray(l) && Array.isArray(r)) return l.concat(r);
    if (l instanceof MossTuple && r instanceof MossTuple) return new MossTuple(l.items.concat(r.items));
    if (l instanceof MossDict && r instanceof MossDict) {
      const d = new MossDict();
      for (const [k, v] of l.itemsArray()) d.set(k, v);
      for (const [k, v] of r.itemsArray()) d.set(k, v);
      return d;
    }
    return Number(l) + Number(r);
  }

  function pyCompare(op, l, r) {
    switch (op) {
      case '==': return pyEqual(l, r);
      case '!=': return !pyEqual(l, r);
      case '<': return pyLessThan(l, r);
      case '>': return pyGreaterThan(l, r);
      case '<=': return !pyGreaterThan(l, r);
      case '>=': return !pyLessThan(l, r);
      case 'in': return pyContains(r, l);
      case 'not in': return !pyContains(r, l);
      case 'is': return l === r;
      default: throw new MOSSRuntimeError(`RuntimeError: 未知比较 ${op}`);
    }
  }

  function pyEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!pyEqual(a[i], b[i])) return false;
      return true;
    }
    if (a instanceof MossDict && b instanceof MossDict) {
      if (a.size() !== b.size()) return false;
      for (const [k, v] of a.itemsArray()) if (!b.has(k) || !pyEqual(v, b.get(k))) return false;
      return true;
    }
    return a === b;
  }

  function pyLessThan(a, b) {
    if (typeof a === 'string' && typeof b === 'string') return a < b;
    if (typeof a === 'number' && typeof b === 'number') return a < b;
    throw new MOSSRuntimeError('TypeError: 该类型不支持 < 比较');
  }
  function pyGreaterThan(a, b) {
    if (typeof a === 'string' && typeof b === 'string') return a > b;
    if (typeof a === 'number' && typeof b === 'number') return a > b;
    throw new MOSSRuntimeError('TypeError: 该类型不支持 > 比较');
  }

  function pyContains(container, elem) {
    if (typeof container === 'string') return container.includes(String(elem));
    if (Array.isArray(container)) return container.some(x => pyEqual(x, elem));
    if (container instanceof MossTuple) return container.items.some(x => pyEqual(x, elem));
    if (container instanceof MossDict) return container.has(elem);
    throw new MOSSRuntimeError('TypeError: 该对象不支持 in 操作');
  }

  // 对象方法分发
  function getMethod(obj, attr, interp) {
    if (typeof obj === 'string') {
      const methods = {
        upper: () => obj.toUpperCase(),
        lower: () => obj.toLowerCase(),
        strip: () => obj.trim(),
        lstrip: () => obj.replace(/^\s+/, ''),
        rstrip: () => obj.replace(/\s+$/, ''),
        split: (sep) => sep ? obj.split(sep) : obj.split(/\s+/),
        rsplit: (sep, n) => sep ? obj.split(sep) : obj.split(/\s+/),
        join: (arr) => (Array.isArray(arr) ? arr.map(String).join(obj) : String(arr)),
        replace: (a, b) => obj.split(a).join(b),
        startswith: (s) => obj.startsWith(s),
        endswith: (s) => obj.endsWith(s),
        find: (s) => { const i = obj.indexOf(s); return i < 0 ? -1 : i; },
        rfind: (s) => { const i = obj.lastIndexOf(s); return i < 0 ? -1 : i; },
        count: (s) => obj.split(s).length - 1,
        format: function () { return pyFormat(obj, arguments); },
        index: (s) => { const i = obj.indexOf(s); if (i < 0) throw new MOSSRuntimeError('ValueError: 子串未找到'); return i; },
        isdigit: () => /^\d+$/.test(obj) && obj.length > 0,
        isalpha: () => /^[a-zA-Z]+$/.test(obj) && obj.length > 0,
        isalnum: () => /^[a-zA-Z0-9]+$/.test(obj) && obj.length > 0,
        capitalize: () => obj.charAt(0).toUpperCase() + obj.slice(1).toLowerCase(),
        title: () => obj.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()),
      };
      if (methods[attr]) return { __builtin: true, fn: methods[attr] };
    }
    if (Array.isArray(obj)) {
      const methods = {
        append: (x) => { obj.push(x); return null; },
        pop: (i) => i === undefined ? obj.pop() : obj.splice(i, 1)[0],
        extend: (arr) => { if (Array.isArray(arr)) for (const x of arr) obj.push(x); return null; },
        insert: (i, x) => { obj.splice(i, 0, x); return null; },
        remove: (x) => {
          const i = obj.findIndex(v => pyEqual(v, x));
          if (i < 0) throw new MOSSRuntimeError('ValueError: 列表中没有该元素');
          obj.splice(i, 1);
          return null;
        },
        index: (x) => {
          const i = obj.findIndex(v => pyEqual(v, x));
          if (i < 0) throw new MOSSRuntimeError('ValueError: 列表中没有该元素');
          return i;
        },
        count: (x) => obj.filter(v => pyEqual(v, x)).length,
        sort: () => { obj.sort((a, b) => pyLessThan(a, b) ? -1 : (pyGreaterThan(a, b) ? 1 : 0)); return null; },
        reverse: () => { obj.reverse(); return null; },
        copy: () => obj.slice(),
        clear: () => { obj.length = 0; return null; },
      };
      if (methods[attr]) return { __builtin: true, fn: methods[attr] };
    }
    if (obj instanceof MossDict) {
      const methods = {
        keys: () => obj.itemsArray().map(kv => kv[0]),
        values: () => obj.itemsArray().map(kv => kv[1]),
        items: () => obj.itemsArray(),
        get: (k, d) => obj.has(k) ? obj.get(k) : (d !== undefined ? d : null),
        pop: (k) => {
          if (!obj.has(k)) throw new MOSSRuntimeError(`KeyError: '${k}'`);
          const v = obj.get(k);
          const key = typeof k === 'object' ? JSON.stringify(k) : k;
          obj._map.delete(key);
          return v;
        },
        update: (other) => {
          if (other instanceof MossDict) {
            for (const [k, v] of other.itemsArray()) obj.set(k, v);
          }
          return null;
        },
        copy: () => {
          const d = new MossDict();
          for (const [k, v] of obj.itemsArray()) d.set(k, v);
          return d;
        },
        clear: () => { obj._map.clear(); return null; },
      };
      if (methods[attr]) return { __builtin: true, fn: methods[attr] };
    }
    if (obj instanceof MossTuple) {
      const methods = {
        count: (x) => obj.items.filter(v => pyEqual(v, x)).length,
        index: (x) => {
          const i = obj.items.findIndex(v => pyEqual(v, x));
          if (i < 0) throw new MOSSRuntimeError('ValueError: 元组中没有该元素');
          return i;
        },
      };
      if (methods[attr]) return { __builtin: true, fn: methods[attr] };
    }
    throw new MOSSRuntimeError(`AttributeError: 对象没有属性 '${attr}'`);
  }

  function pyFormat(template, args) {
    let idx = 0;
    return template.replace(/\{\}/g, () => {
      if (idx < args.length) return pyRepr(args[idx++]);
      return '{}';
    });
  }

  // ============================================================
  //  Bot（一个 bot = MOSS 源码 + 运行时状态）
  // ============================================================

  class Bot {
    constructor(name, source) {
      this.name = name;
      this.source = source;
      this.lastChoice = null;
      this.logs = [];
      this.error = null;
      this.history = [];      // 自己每轮决策
      this.oppHistory = [];   // 对手每轮决策（1v1 模式）
      this.lastWin = false;
      this.lastRound = 0;
      this._compile();
    }

    _compile() {
      try {
        const tokens = tokenize(this.source);
        const parser = new Parser(tokens);
        const ast = parser.parse();
        this.ast = ast;
        this.compileError = null;
      } catch (e) {
        this.compileError = e.message || String(e);
        this.ast = null;
      }
    }

    // 引擎每轮调用，返回 'cooperate' / 'defect'
    decide(ctx) {
      if (this.compileError) {
        this.error = this.compileError;
        return 'defect';
      }
      if (!this.ast) {
        this.error = 'AST 未生成';
        return 'defect';
      }

      // 每轮创建新解释器，但保留编译好的 AST
      const api = {
        win: ctx.win || false,
        round: ctx.round || 0,
        history: this.history.slice(),
        oppHistory: this.oppHistory.slice(),
        choice: null,
        logs: [],
        choose(opt) {
          if (opt !== 'cooperate' && opt !== 'defect') {
            this.logs.push(`ValueError: choose() 只接受 'cooperate' 或 'defect'，实际收到 '${opt}'`);
            return;
          }
          this.choice = opt;
        },
        delay(s) { /* 思考时间，实际不影响决策 */ },
        log(s) { this.logs.push(s); },
        getWin: () => api.win,
        getRound: () => api.round,
        getHistory: () => api.history,
        getOpponentHistory: () => api.oppHistory,
      };

      let interp;
      try {
        interp = new Interpreter(this.ast, api);
        interp.run();
        // 调用 main()
        const timeoutStart = Date.now();
        interp.decide();
        if (Date.now() - timeoutStart > 200) {
          this.error = 'TimeoutWarning: main() 执行时间过长';
        }
      } catch (e) {
        this.error = e.message || String(e);
        api.logs.push('运行时错误: ' + this.error);
        this.logs = api.logs;
        return 'defect';
      }

      this.logs = api.logs;
      this.error = null;
      const choice = api.choice !== null ? api.choice : 'defect';
      return choice;
    }

    recordRound(choice, oppChoice) {
      this.history.push(choice);
      this.oppHistory.push(oppChoice);
    }
  }

  // ============================================================
  //  Arena（囚徒困境博弈引擎）
  // ============================================================

  // 计分矩阵
  const PD_SCORE = {
    'CC': 3, // R - 双方合作
    'DD': 1, // P - 双方背叛
    'CD': 0, // S - 合作被背叛
    'DC': 5, // T - 背叛对方合作
  };

  class Arena {
    constructor(config = {}) {
      this.rounds = config.rounds || 200;
      this.mode = config.mode || '1v1'; // '1v1' | 'round-robin'
      this.bots = [];
      this.verbose = config.verbose !== false;
      this.onRound = config.onRound || null;
      this.onMatchEnd = config.onMatchEnd || null;
    }

    addBot(name, source) {
      const bot = new Bot(name, source);
      this.bots.push(bot);
      return bot;
    }

    // 计算单轮得分
    score(choiceA, choiceB) {
      const a = choiceA[0].toUpperCase();
      const b = choiceB[0].toUpperCase();
      return { a: PD_SCORE[a + b], b: PD_SCORE[b + a] };
    }

    // 1v1 单场比赛
    run1v1(botA, botB) {
      const rounds = [];
      botA.history = [];
      botA.oppHistory = [];
      botB.history = [];
      botB.oppHistory = [];

      let scoreA = 0, scoreB = 0;

      for (let r = 0; r < this.rounds; r++) {
        const ctxA = { win: r > 0 ? (rounds[r - 1].a > rounds[r - 1].b) : false, round: r };
        const ctxB = { win: r > 0 ? (rounds[r - 1].b > rounds[r - 1].a) : false, round: r };

        const choiceA = botA.decide(ctxA);
        const choiceB = botB.decide(ctxB);

        botA.recordRound(choiceA, choiceB);
        botB.recordRound(choiceB, choiceA);

        const s = this.score(choiceA, choiceB);
        scoreA += s.a;
        scoreB += s.b;

        rounds.push({
          round: r,
          a: { name: botA.name, choice: choiceA, score: s.a, total: scoreA },
          b: { name: botB.name, choice: choiceB, score: s.b, total: scoreB },
        });

        if (this.onRound) this.onRound(rounds[r]);
      }

      const result = {
        botA: botA.name, botB: botB.name,
        scoreA, scoreB,
        winner: scoreA > scoreB ? botA.name : (scoreB > scoreA ? botB.name : 'tie'),
        rounds,
      };

      if (this.onMatchEnd) this.onMatchEnd(result);
      return result;
    }

    // round-robin：每对 bot 两两对战，累计积分
    runRoundRobin() {
      const totals = {};
      const matchResults = [];
      for (const bot of this.bots) totals[bot.name] = 0;

      for (let i = 0; i < this.bots.length; i++) {
        for (let j = i + 1; j < this.bots.length; j++) {
          const result = this.run1v1(this.bots[i], this.bots[j]);
          matchResults.push(result);
          totals[this.bots[i].name] += result.scoreA;
          totals[this.bots[j].name] += result.scoreB;
        }
      }

      const ranking = Object.entries(totals)
        .map(([name, score]) => ({ name, score }))
        .sort((a, b) => b.score - a.score);

      return { mode: 'round-robin', totals, ranking, matchResults };
    }

    runMatch() {
      if (this.mode === '1v1') {
        if (this.bots.length < 2) throw new Error('1v1 模式需要至少 2 个 bot');
        return this.run1v1(this.bots[0], this.bots[1]);
      }
      return this.runRoundRobin();
    }
  }

  // ============================================================
  //  公开 API
  // ============================================================

  global.MOSS = {
    tokenize,
    Parser,
    Interpreter,
    Bot,
    Arena,
    Bot: Bot,
    PD_SCORE,
    // 让用户能从控制台测试
    _internal: { MossDict, MossTuple, pyRepr, isTruthy },
  };
})(typeof window !== 'undefined' ? window : globalThis);
