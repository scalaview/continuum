var bytecode = (function(exports){
  var utility   = require('./utility'),
      util      = require('util');

  var visit     = utility.visit,
      collector = utility.collector,
      Stack     = utility.Stack,
      define    = utility.define,
      assign    = utility.assign,
      create    = utility.create,
      copy      = utility.copy,
      parse     = utility.parse,
      decompile = utility.decompile,
      inherit   = utility.inherit,
      ownKeys   = utility.keys,
      isObject  = utility.isObject,
      quotes    = utility.quotes;

  var constants = require('./constants'),
      BINARYOPS = constants.BINARYOPS,
      UNARYOPS  = constants.UNARYOPS,
      ENTRY     = constants.ENTRY,
      AST       = constants.AST,
      FUNCTYPE  = constants.FUNCTYPE;

  var hasOwn = {}.hasOwnProperty;






  function parenter(node, parent){
    visit(node, function(node){
      if (isObject(node) && parent)
        define(node, 'parent', parent);
      return visit.RECURSE;
    });
  }

  function reinterpretNatives(node){
    visit(node, function(node){
      if (node.type === 'Identifier' && /^\$__/.test(node.name)) {
        node.type = 'NativeIdentifier';
        node.name = node.name.slice(3);
      } else {
        return visit.RECURSE;
      }
    });
  }


  var boundNamesCollector = collector({
    ObjectPattern      : visit.RECURSE,
    ArrayPattern       : visit.RECURSE,
    VariableDeclaration: visit.RECURSE,
    VariableDeclarator : visit.RECURSE,
    BlockStatement     : visit.RECURSE,
    Identifier         : ['name'],
    FunctionDeclaration: ['id', 'name'],
    ClassDeclaration   : ['id', 'name']
  });

  function BoundNames(node){
    var names = boundNamesCollector(node);
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      return names.slice(1);
    } else {
      return names;
    }
  }


  var LexicalDeclarations = (function(lexical){
    return collector({
      ClassDeclaration: lexical(false),
      FunctionDeclaration: lexical(false),
      SwitchCase: visit.RECURSE,
      VariableDeclaration: lexical(function(node){
        return node.kind === 'const';
      }),
    });
  })(function(isConst){
    if (typeof isConst !== 'function') {
      isConst = (function(v){
        return function(){ return v };
      })(isConst);
    }
    return function(node){
      node.IsConstantDeclaration = isConst(node);
      node.BoundNames = BoundNames(node);
      return node;
    };
  });


  function isSuperReference(node) {
    return !!node && node.type === 'Identifier' && node.name === 'super';
  }

  function ReferencesSuper(node){
    var found = false;
    visit(node, function(node){
      switch (node.type) {
        case 'MemberExpression':
          if (isSuperReference(node.object)) {
            found = true;
            return visit.BREAK;
          }
        case 'CallExpression':
          if (isSuperReference(node.callee)) {
            found = true;
            return visit.BREAK;
          }
          break;
        case 'FunctionExpression':
        case 'FunctionDeclaration':
        case 'ArrowFunctionExpression':
          return visit.CONTINUE;
      }
      return visit.RECURSE;
    });
    return found;
  }

  function isUseStrictDirective(node){
    return node.type === 'ExpressionSatatement'
        && node.expression.type === 'Literal'
        && node.expression.value === 'use strict';
  }

  function isFunction(node){
    return node.type === 'FunctionDeclaration'
        || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression';
  }

  function isStrict(node){
    if (isFunction(node)) {
      node = node.body.body;
    } else if (node.type === 'Program') {
      node = node.body;
    }
    if (node instanceof Array) {
      for (var i=0, element;  element = node[i]; i++) {
        if (element) {
          if (isUseStrictDirective(element)) {
            return true;
          } else if (element.type !== 'EmptyStatement' && element.type !== 'FunctionDeclaration') {
            return false;
          }
        }
      }
    }
    return false;
  }

  function isPattern(node){
    return !!node && node.type === 'ObjectPattern' || node.type === 'ArrayPattern';
  }

  function Operations(){
    this.length = 0;
  }

  inherit(Operations, Array, [
    function toJSON(){
      return this.map(function(op){
        return op.toJSON();
      });
    }
  ]);


  var collectExpectedArguments = collector({
    Identifier: true,
    ObjectPattern: true,
    ArrayPattern: true,
  });

  function Params(params, node, rest){
    this.length = 0;
    if (params) {
      [].push.apply(this, params);
    }
    this.Rest = rest;
    this.BoundNames = BoundNames(node);
    var args = collectExpectedArguments(this);
    this.ExpectedArgumentCount = args.length;
    this.ArgNames = [];
    for (var i=0; i < args.length; i++) {
      if (args[i].type === 'Identifier') {
        this.ArgNames.push(args[i].name);
      } else {

      }
    }
  }

  function recurse(o){
    var out = o instanceof Array ? [] : {};
    if (o.type === 'Identifier') {
      return o.name;
    }
    ownKeys(o).forEach(function(key){
      if (key === 'type' && o.type in types) {
        out.type = types[o.type];
      } else if (o[key] && typeof o[key] === 'object') {
        out[key] = recurse(o[key]);
      } else {
        out[key] = o[key];
      }
    });
    return out;
  }

  define(Params.prototype, [
    function toJSON(){
      return [recurse([].slice.call(this)),  this.BoundNames];
    }
  ]);

  function Code(node, source, type, isGlobal, strict){

    function Instruction(args){
      Operation.apply(this, args);
    }

    inherit(Instruction, Operation, {
      code: this
    });

    this.topLevel = node.type === 'Program';
    var body = this.topLevel ? node : node.body;
    define(this, {
      body: body,
      source: source,
      LexicalDeclarations: LexicalDeclarations(node),
      createOperation: function(args){
        var op =  new Instruction(args);
        this.ops.push(op);
        return op;
      }
    });

    this.range = node.range;
    this.loc = node.loc;

    this.isGlobal = isGlobal;
    this.entrances = [];
    this.Type = type || FUNCTYPE.hash.NORMAL;
    this.VarDeclaredNames = [];
    this.NeedsSuperBinding = ReferencesSuper(this.body);
    this.Strict = strict || isStrict(this.body);
    this.params = new Params(node.params, node, node.rest);
    this.ops = new Operations;
    this.children = [];

  }
  var identifiersPrinted = false;

  define(Code.prototype, [
    function inherit(code){
      if (code) {
        this.identifiers = code.identifiers;
        this.hash = code.hash;
        this.natives = code.natives;
      }
    },
    function intern(name){
      return name;
      if (name in this.hash) {
        return this.hash[name];
      } else {
        var index = this.hash[name] = this.identifiers.length;
        this.identifiers[index] = name;
        return index;
      }
    },
    function lookup(id){
      return id;
      if (typeof id === 'number') {
        return this.identifiers[id];
      } else {
        return id;
      }
    },
    function toJSON(){
      var out = {}

      out.type = this.Type;
      out.params = this.params.toJSON();
      out.ops = this.ops.toJSON()
      out.params[0] = out.params[0].map(this.intern.bind(this));
      out.params[1] = out.params[1].map(function(param){
        if (typeof param === 'string') {
          return this.intern(param);
        } else {
          return param;
        }
      }, this);
      if (this.VarDeclaredNames.length) {
        out.vars = this.VarDeclaredNames.map(this.intern.bind(this));
      }
      if (this.LexicalDeclarations.length) {
        out.decls = this.LexicalDeclarations;
      }
      if (this.topLevel) {
        if (this.natives) {
          out.natives = true;
        }
      }
      if (this.eval) {
        out.eval = true;
      }
      if (this.isGlobal) {
        out.isGlobal = true;
      }
      if (this.entrances.length) {
        out.entrances = this.entrances.map(function(entrance){
          return entrance.toJSON();
        });
      }
      if (this.NeedsSuperBinding) {
        out.needsSuper = true;
      }

      if (this.topLevel) {
        out.identifiers = this.identifiers;
      }
      return out;
    }
  ]);


  function OpCode(id, params, name){
    this.id = id;
    this.params = params;
    this.name = name;
  }

  define(OpCode.prototype, [
    function inspect(){
      return this.name;
    },
    function toString(){
      return this.name
    },
    function valueOf(){
      return this.id;
    },
    function toJSON(){
      return this.id;
    }
  ]);



  var ARRAY          = new OpCode( 0, 0, 'ARRAY'),
      ARRAY_DONE     = new OpCode( 1, 0, 'ARRAY_DONE'),
      BINARY         = new OpCode( 2, 1, 'BINARY'),
      BLOCK          = new OpCode( 3, 1, 'BLOCK'),
      BLOCK_EXIT     = new OpCode( 4, 0, 'BLOCK_EXIT'),
      CALL           = new OpCode( 5, 0, 'CALL'),
      CASE           = new OpCode( 6, 1, 'CASE'),
      CLASS_DECL     = new OpCode( 7, 1, 'CLASS_DECL'),
      CLASS_EXPR     = new OpCode( 8, 1, 'CLASS_EXPR'),
      CONST          = new OpCode( 9, 1, 'CONST'),
      CONSTRUCT      = new OpCode(10, 0, 'CONSTRUCT'),
      DEBUGGER       = new OpCode(11, 0, 'DEBUGGER'),
      DEFAULT        = new OpCode(12, 1, 'DEFAULT'),
      DUP            = new OpCode(13, 0, 'DUP'),
      ELEMENT        = new OpCode(14, 0, 'ELEMENT'),
      FUNCTION       = new OpCode(15, 2, 'FUNCTION'),
      GET            = new OpCode(16, 0, 'GET'),
      IFEQ           = new OpCode(17, 2, 'IFEQ'),
      IFNE           = new OpCode(18, 2, 'IFNE'),
      INDEX          = new OpCode(19, 2, 'INDEX'),
      JSR            = new OpCode(20, 2, 'JSR'),
      JUMP           = new OpCode(21, 1, 'JUMP'),
      LET            = new OpCode(22, 1, 'LET'),
      LITERAL        = new OpCode(23, 1, 'LITERAL'),
      MEMBER         = new OpCode(24, 1, 'MEMBER'),
      METHOD         = new OpCode(25, 3, 'METHOD'),
      OBJECT         = new OpCode(26, 0, 'OBJECT'),
      POP            = new OpCode(27, 0, 'POP'),
      SAVE           = new OpCode(28, 0, 'SAVE'),
      POPN           = new OpCode(29, 1, 'POPN'),
      PROPERTY       = new OpCode(30, 1, 'PROPERTY'),
      PUT            = new OpCode(31, 0, 'PUT'),
      REGEXP         = new OpCode(32, 1, 'REGEXP'),
      REF            = new OpCode(33, 1, 'REF'),
      RETURN         = new OpCode(34, 0, 'RETURN'),
      COMPLETE       = new OpCode(35, 0, 'COMPLETE'),
      ROTATE         = new OpCode(36, 1, 'ROTATE'),
      RUN            = new OpCode(37, 0, 'RUN'),
      SUPER_CALL     = new OpCode(38, 0, 'SUPER_CALL'),
      SUPER_ELEMENT  = new OpCode(39, 0, 'SUPER_ELEMENT'),
      SUPER_GUARD    = new OpCode(40, 0, 'SUPER_GUARD'),
      SUPER_MEMBER   = new OpCode(41, 1, 'SUPER_MEMBER'),
      THIS           = new OpCode(42, 0, 'THIS'),
      THROW          = new OpCode(43, 1, 'THROW'),
      UNARY          = new OpCode(44, 1, 'UNARY'),
      UNDEFINED      = new OpCode(45, 0, 'UNDEFINED'),
      UPDATE         = new OpCode(46, 1, 'UPDATE'),
      VAR            = new OpCode(47, 1, 'VAR'),
      WITH           = new OpCode(48, 0, 'WITH'),
      NATIVE_REF     = new OpCode(49, 1, 'NATIVE_REF'),
      ENUM           = new OpCode(50, 0, 'ENUM'),
      NEXT           = new OpCode(51, 1, 'NEXT'),
      STRING         = new OpCode(52, 1, 'STRING'),
      NATIVE_CALL    = new OpCode(53, 0, 'NATIVE_CALL'),
      TO_OBJECT      = new OpCode(54, 0, 'TO_OBJECT'),
      SPREAD         = new OpCode(55, 1, 'SPREAD'),
      ARGS           = new OpCode(56, 0, 'ARGS'),
      ARG            = new OpCode(57, 0, 'ARG'),
      SPREAD_ARG     = new OpCode(58, 0, 'SPREAD_ARG');



  function Operation(op, a, b, c, d){
    this.op = op;
    for (var i=0; i < op.params; i++) {
      this[i] = arguments[i + 1];
    }
  }

  var seen;

  define(Operation.prototype, [
    function inspect(){
      var out = [];
      for (var i=0; i < this.op.params; i++) {
        if (typeof this[i] === 'number') {
          var interned = this.code.lookup(this[i]);
          if (typeof interned === 'string') {
            out.push(interned)
          }
        } else if (this[i] && typeof this[i] === 'object') {
          if (!seen) {
            seen = new WeakMap;
            setTimeout(function(){ seen = null });
          }
          if (!seen.has(this[i])) {
            seen.set(this[i], true);
            out.push(util.inspect(this[i]));
          } else {
          out.push('...');
          }
        } else {
          out.push(util.inspect(this[i]));
        }
      }

      return util.inspect(this.op)+'('+out.join(', ')+')';
    },
    function toJSON(){
      if (this.op.params) {
        var out = [this.op.toJSON()];
        for (var i=0; i < this.op.params; i++) {
          if (this[i] && this[i].toJSON) {
            out[i+1] = this[i].toJSON();
          } else if (typeof this[i] === 'boolean') {
            out[i+1] = +this[i];
          } else if (typeof this[i] !== 'object' || this[i] == null) {
            out[i+1] = this[i];
          }
        }
        return out;
      } else {
        return this.op.toJSON()
      }
    }
  ]);


  function ClassDefinition(pattern, superclass, constructor, methods){
    this.pattern = pattern;
    this.superclass = superclass;
    this.ctor = constructor;
    this.methods = methods;
  }

  function Handler(type, begin, end){
    this.type = type;
    this.begin = begin;
    this.end = end;
  }

  define(Handler.prototype, [
    function toJSON(){
      return [this.type, this.begin, this.end];
    }
  ]);



  function Entry(labels, level){
    this.labels = labels;
    this.level = level;
    this.breaks = [];
    this.continues = [];
  }

  define(Entry.prototype, {
    labels: null,
    breaks: null,
    continues: null,
    level: null
  })

  define(Entry.prototype, [
    function updateContinues(address){
      for (var i=0, item; item = this.breaks[i]; i++)
        item.position = breakAddress;
    },
    function updateBreaks(address){
      for (var i=0, item; item = this.continues[i]; i++)
        item.position = continueAddress;
    }
  ]);


  function CompilerOptions(o){
    o = Object(o);
    for (var k in this)
      this[k] = k in o ? o[k] : this[k];
  }

  CompilerOptions.prototype = {
    eval: false,
    normal: true,
    scoped: false,
    natives: false
  };

  var destructureNode = {
    elements: function(node, index){
      return node.elements[index];
    },
    properties: function(node, index){
      return node.properties[index].value;
    }
  };



  function Compiler(options){
    this.options = new CompilerOptions(options);
  }

  define(Compiler.prototype, {
    source: null,
    node: null,
    code: null,
    pending: null,
    levels: null,
    jumps: null,
    labels: null,
  });

  define(Compiler.prototype, [
    function compile(source){
      this.pending = new Stack;
      this.levels = new Stack;
      this.jumps = new Stack;
      this.labels = null;

      var node = parse(source);
      if (this.options.normal)
        node = node.body[0].expression;


      var type = this.options.eval ? 'eval' : this.options.normal ? 'function' : 'global';
      var code = new Code(node, source, type, !this.options.scoped);
      code.identifiers = [];
      code.hash = create(null);
      code.topLevel = true;
      if (this.options.natives) {
        code.natives = true;
        reinterpretNatives(node);
      }

      this.queue(code);
      parenter(node);


      while (this.pending.length) {
        var lastCode = this.code;
        this.code = this.pending.pop();
        if (lastCode) {
          this.code.inherit(lastCode);
        }
        this.visit(this.code.body);
        if (this.code.eval || this.code.isGlobal){
          this.record(COMPLETE);
        } else {
          if (this.Type !== FUNCTYPE.ARROW) {
            this.record(UNDEFINED);
          }
          this.record(RETURN);
        }
      }

      return code;
    },
    function queue(code){
      if (this.code) {
        this.code.children.push(code);
      }
      this.pending.push(code);
    },
    function visit(node){
      if (node) {
        this[node.type](node);
      }
      return this;
    },
    function record(){
      return this.code.createOperation(arguments);
    },
    function current(){
      return this.code.ops.length;
    },
    function last(){
      return this.code.ops[this.code.ops.length - 1];
    },
    function adjust(op){
      return op[0] = this.code.ops.length;
    },

    function withBlock(func){
      if (this.labels){
        var entry = new Entry(this.labels, this.levels.length);
        this.jumps.push(entry);
        this.labels = create(null);
        func.call(this, function(b, c){
          entry.updateBreaks(b);
        });
        this.jumps.pop();
      } else {
        func.call(this, function(){});
      }
    },
    function withEntry(func){
      var entry = new Entry(this.labels, this.levels.length);
      this.jumps.push(entry);
      this.labels = create(null);
      func.call(this, function (b, c){
        entry.updateBreaks(b);
        if (c !== undefined) {
          entry.updateContinues(c);
        }
      });
      this.jumps.pop();
    },
    function recordEntrypoint(type, func){
      var begin = this.current();
      func.call(this);
      this.code.entrances.push(new Handler(type, begin, this.current()));
    },
    function move(node){
      if (node.label) {
        var entry = this.jumps.first(function(entry){
          return node.label.name in entry.labels;
        });
      } else {
        var entry = this.jumps.first(function(entry){
          return entry && entry.continues;
        });
      }

      var levels = {
        FINALLY: function(level){
          level.entries.push(this.record(JSR, 0, false));
        },
        WITH: function(){
          this.record(BLOCK_EXIT);
        },
        SUBROUTINE: function(){
          this.record(POPN, 3);
        },
        FORIN: function(){
          entry.level + 1 !== len && this.record(POP);
        }
      };

      var min = entry ? entry.level : 0;
      for (var len = this.levels.length; len > min; --len){
        var level = this.levels[len - 1];
        levels[level.type].call(this, level);
      }
      return entry;
    },
    function destructure(a, b){
      var key = a.type === 'ArrayPattern' ? 'elements' : 'properties';

      for (var i=0; i < a[key].length; i++) {
        var left = destructureNode[key](a, i);
        if (b[key] && b[key][i]) {
          right = destructureNode[key](b, i);
        } else {
          right = destructureNode[key](a, i);
        }

        if (isPattern(left)){
          this.destructure(left, right);
        } else {
          if (left.type === 'SpreadElement') {
            this.visit(left.argument);
            this.visit(b);
            this.record(GET);
            this.record(SPREAD, i);
          } else {
            this.visit(left);
            this.visit(b);
            this.record(GET);
            if (a.type === 'ArrayPattern') {
              this.record(LITERAL, i);
              this.record(ELEMENT, i);
            } else {
              this.record(MEMBER, a[key][i].key.name)
            }
            this.record(GET);
          }
          this.record(PUT);
        }
      }
    },
    function AssignmentExpression(node){
      if (node.operator === '='){
        if (isPattern(node.left)){
          this.destructure(node.left, node.right);
        } else {
          this.visit(node.left);
          this.visit(node.right);
          this.record(GET);
          this.record(PUT);
        }
      } else {
        this.visit(node.left);
        this.record(DUP);
        this.record(GET);
        this.visit(node.right);
        this.record(GET);
        this.record(BINARY, BINARYOPS.getIndex(node.operator.slice(0, -1)));
        this.record(PUT);
      }
    },
    function ArrayExpression(node){
      this.record(ARRAY);
      for (var i=0, item; i < node.elements.length; i++) {
        var empty = false,
            spread = false,
            item = node.elements[i];

        if (!item){
          empty = true;
        } else if (item.type === 'SpreadElement'){
          spread = true;
          this.visit(item.argument);
        } else {
          this.visit(item);
        }

        this.record(INDEX, empty, spread);
      }

      this.record(ARRAY_DONE);
    },
    function ArrowFunctionExpression(node){
      var code = new Code(node, this.code.source, FUNCTYPE.hash.ARROW, false, this.code.strict);
      this.queue(code);
      this.record(FUNCTION, null, code);
    },
    function BinaryExpression(node){
      this.visit(node.left);
      this.record(GET);
      this.visit(node.right);
      this.record(GET);
      this.record(BINARY, BINARYOPS.getIndex(node.operator));
    },
    function BreakStatement(node){
      var entry = this.move(node);
      if (entry) {
        entry.breaks.push(this.record(JUMP, 0));
      }
    },
    function BlockStatement(node){
      this.withBlock(function(patch){
        this.recordEntrypoint(ENTRY.hash.ENV, function(){
          this.record(BLOCK, { LexicalDeclarations: LexicalDeclarations(node.body) });

          for (var i=0, item; item = node.body[i]; i++)
            this.visit(item);

          this.record(BLOCK_EXIT);
        });
        patch(this.current());
      });
    },
    function CallExpression(node){
      if (isSuperReference(node.callee)) {
        if (this.code.Type === 'global' || this.code.Type === 'eval' && this.code.isGlobal)
          throw new Error('Illegal super reference');
        this.record(SUPER_CALL);
      } else {
        this.visit(node.callee);
      }
      this.record(DUP);
      this.record(GET);
      this.args(node.arguments);
      this.record(node.callee.type === 'NativeIdentifier' ? NATIVE_CALL : CALL);
    },
    function args(node){
      this.record(ARGS);
      for (var i=0, item; item = node[i]; i++) {
        if (item && item.type === 'SpreadElement') {
          this.visit(item.argument);
          this.record(GET);
          this.record(SPREAD_ARG);
        } else {
          this.visit(item);
          this.record(GET);
          this.record(ARG);
        }
      }
    },
    function CatchClause(node){
      this.recordEntrypoint(ENTRY.hash.ENV, function(){
        var decls = LexicalDeclarations(node.body);
        decls.push({
          type: 'VariableDeclaration',
          kind: 'var',
          IsConstantDeclaration: false,
          BoundNames: [node.param.name],
          declarations: [{
            type: 'VariableDeclarator',
            id: node.param,
            init: undefined
          }]
        });
        this.record(BLOCK, { LexicalDeclarations: decls });
        this.visit(node.param);
        this.record(GET);
        this.record(PUT);
        for (var i=0, item; item = node.body.body[i]; i++)
          this.visit(item);

        this.record(BLOCK_EXIT);
      });
    },
    function ClassDeclaration(node){
      var name = node.id ? node.id.name : null,
          methods = [],
          ctor;

      for (var i=0, method; method = node.body.body[i]; i++) {
        var code = new Code(method.value, this.source, FUNCTYPE.hash.METHOD, false, this.code.strict);
        code.name = method.key.name;
        this.pending.push(code);

        if (method.kind === '') {
          method.kind = 'method';
        }

        if (method.key.name === 'constructor') {
          ctor = code;
        } else {
          methods.push({
            kind: method.kind,
            code: code,
            name: method.key.name
          });
        }
      }

      if (node.superClass) {
        this.visit(node.superClass);
        this.record(GET);
        var superClass = node.superClass.name;
      }

      var type = node.type === 'ClassExpression' ? CLASS_EXPR : CLASS_DECL;
      this.record(type, new ClassDefinition(node.id, superClass, ctor, methods));
    },
    function ClassExpression(node){
      this.ClassDeclaration(node);
    },
    function ClassHeritage(node){ },
    function ConditionalExpression(node){
      this.visit(node.test);
      this.record(GET);
      var test = this.record(IFEQ, 0, false);
      this.visit(node.consequent)
      this.record(GET);
      var alt = this.record(JUMP, 0);
      this.adjust(test);
      this.visit(node.alternate);
      this.record(GET);
      this.adjust(alt)
    },
    function ContinueStatement(node){
      var entry = this.move(node);
      if (entry)
        entry.continues.push(this.record(JUMP, 0));
    },
    function DoWhileStatement(node){
      this.withEntry(function(patch){
        var start = this.current();
        this.visit(node.body);
        var cond = this.current();
        this.visit(node.test);
        this.record(GET);
        this.record(IFEQ, start, true);
        patch(this.current(), cond);
      });
    },
    function DebuggerStatement(node){
      this.record(DEBUGGER);
    },
    function EmptyStatement(node){},
    function ExportSpecifier(node){},
    function ExportSpecifierSet(node){},
    function ExportDeclaration(node){},
    function ExpressionStatement(node){
      this.visit(node.expression);
      this.record(GET);
      if (this.code.eval || this.code.isGlobal) {
        this.record(SAVE)
      } else {
        this.record(POP);
      }
    },

    function ForStatement(node){
      this.withEntry(function(patch){
        if (node.init){
          this.visit(node.init);
          if (node.init.type !== 'VariableDeclaration') {
            this.record(GET);
            this.record(POP);
          }
        }

        var test = this.current();
        if (node.test) {
          this.visit(node.test);
          this.record(GET);
          var op = this.record(IFEQ, 0, false);
        }
        var update = this.current();

        this.visit(node.body);
        if (node.update) {
          this.visit(node.update);
          this.record(GET);
          this.record(POP);
        }

        this.record(JUMP, test);
        this.adjust(op);
        patch(this.current(), update);
      });
    },
    function ForInStatement(node){
      this.withEntry(function(patch){
        this.visit(node.left);
        this.record(REF, this.last()[0].name);
        this.visit(node.right);
        this.record(GET);
        this.record(ENUM);
        var update = this.current();
        var op = this.record(NEXT);
        this.visit(node.body);
        this.record(JUMP, update);
        this.adjust(op);
        patch(this.current(), update);
      });
    },
    function ForOfStatement(node){
      this.withEntry(function(patch){
        this.visit(node.right);
        this.record(GET);
        this.record(MEMBER, this.code.intern('iterator'));
        this.record(GET);
        this.record(ARGS);
        this.record(CALL);
        this.record(ROTATE, 4);
        this.record(POPN, 3);
        var update = this.current();
        this.record(MEMBER, this.code.intern('next'));
        this.record(GET);
        this.record(ARGS);
        this.record(CALL);
        this.visit(node.left);
        this.visit(node.body);
        this.record(JUMP, update);
        this.adjust(op);
        this.record(POPN, 2);
        patch(this.current(), update);
      });
    },
    function FunctionDeclaration(node){
      node.Code = new Code(node, this.code.source, FUNCTYPE.hash.NORMAL, false, this.code.strict);
      this.queue(node.Code);
    },
    function FunctionExpression(node){
      var code = new Code(node, this.code.source, FUNCTYPE.hash.NORMAL, false, this.code.strict);
      this.queue(code);
      var name = node.id ? node.id.name : '';
      this.record(FUNCTION, this.code.intern(name), code);
    },
    function Glob(node){},
    function Identifier(node){
      this.record(REF, this.code.intern(node.name));
    },
    function IfStatement(node){
      this.visit(node.test);
      this.record(GET);
      var test = this.record(IFEQ, 0, false);
      this.visit(node.consequent);

      if (node.alternate) {
        var alt = this.record(JUMP, 0);
        this.adjust(test);
        this.visit(node.alternate);
        this.adjust(alt);
      } else {
        this.adjust(test);
      }
    },
    function ImportDeclaration(node){},
    function ImportSpecifier(spec){},
    function Literal(node){
      if (node.value instanceof RegExp) {
        this.record(REGEXP, node.value);
      } else if (typeof node.value === 'string') {
        this.record(STRING, this.code.intern(node.value));
      } else {
        this.record(LITERAL, node.value);
      }
    },
    function LabeledStatement(node){
      if (!this.labels){
        this.labels = create(null);
      } else if (label in this.labels) {
        throw new SyntaxError('duplicate label');
      }
      this.labels[node.label.name] = true;
      this.visit(node.body);
      this.labels = null;
    },
    function LogicalExpression(node){
      this.visit(node.left);
      this.record(GET);
      var op = this.record(IFNE, 0, node.operator === '||');
      this.visit(node.right);
      this.record(GET);
      this.adjust(op);
    },
    function MemberExpression(node){
      var isSuper = isSuperReference(node.object);
      if (isSuper){
        if (this.code.Type === 'global' || this.code.Type === 'eval' && this.code.isGlobal)
          throw new Error('Illegal super reference');
        this.record(SUPER_GUARD);
      } else {
        this.visit(node.object);
        this.record(GET);
      }

      if (node.computed){
        this.visit(node.property);
        this.record(GET);
        this.record(isSuper ? SUPER_ELEMENT : ELEMENT);
      } else {
        this.record(isSuper ? SUPER_MEMBER : MEMBER, this.code.intern(node.property.name));
      }
    },
    function ModuleDeclaration(node){ },
    function NativeIdentifier(node){
      this.record(NATIVE_REF, this.code.intern(node.name));
    },
    function NewExpression(node){
      this.visit(node.callee);
      this.record(GET);
      this.args(node.arguments);
      this.record(CONSTRUCT);
    },
    function ObjectExpression(node){
      this.record(OBJECT);
      for (var i=0, item; item = node.properties[i]; i++)
        this.visit(item);
    },
    function Path(){

    },
    function Program(node){
      for (var i=0, item; item = node.body[i]; i++)
        this.visit(item);
    },
    function Property(node){
      if (node.kind === 'init'){
        this.visit(node.value);
        this.record(GET);
        this.record(PROPERTY, this.code.intern(node.key.name));
      } else {
        var code = new Code(node.value, this.source, FUNCTYPE.hash.NORMAL, false, this.code.strict);
        this.queue(code);
        this.record(METHOD, node.kind, code, this.code.intern(node.key.name));
      }
    },
    function ReturnStatement(node){
      if (node.argument){
        this.visit(node.argument);
        this.record(GET);
      } else {
        this.record(UNDEFINED);
      }

      var levels = {
        FINALLY: function(level){
          level.entries.push(this.record(JSR, 0, true));
        },
        WITH: function(){
          this.record(BLOCK_EXIT);
        },
        SUBROUTINE: function(){
          this.record(ROTATE, 4);
          this.record(POPN, 4);
        },
        FORIN: function(){
          this.record(ROTATE, 4);
          this.record(POP);
        }
      };

      for (var len = this.levels.length; len > 0; --len){
        var level = this.levels[len - 1];
        levels[level.type].call(this, level);
      }

      this.record(RETURN);
    },
    function SequenceExpression(node){
      for (var i=0, item; item = node.expressions[i]; i++) {
        this.visit(item)
        this.record(GET);
        this.record(POP);
      }
      this.visit(item);
      this.record(GET);
    },
    function SwitchStatement(node){
      this.withEntry(function(patch){
        this.visit(node.discriminant);
        this.record(GET);

        this.recordEntrypoint(ENTRY.hash.ENV, function(){
          this.record(BLOCK, { LexicalDeclarations: LexicalDeclarations(node.cases) });

          if (node.cases){
            var cases = [];
            for (var i=0, item; item = node.cases[i]; i++) {
              if (item.test){
                this.visit(item.test);
                this.record(GET);
                cases.push(this.record(CASE, 0));
              } else {
                var defaultFound = i;
                cases.push(0);
              }

            }

            if (defaultFound != null){
              this.record(DEFAULT, cases[defaultFound]);
            } else {
              this.record(POP);
              var last = this.record(JUMP, 0);
            }

            for (var i=0, item; item = node.cases[i]; i++) {
              this.adjust(cases[i])
              for (var j=0, consequent; consequent = item.consequent[j]; j++)
                this.visit(consequent);
            }

            if (last) {
              this.adjust(last);
            }
          } else {
            this.record(POP);
          }

          this.record(BLOCK_EXIT);
        });
        patch(this.current());
      });
    },

    function TemplateElement(node){

    },
    function TemplateLiteral(node){

    },
    function TaggedTemplateExpression(node){

    },
    function ThisExpression(node){
      this.record(THIS);
    },
    function ThrowStatement(node){
      this.visit(node.argument);
      this.record(GET);
      this.record(THROW);
    },
    function TryStatement(node){
      this.recordEntrypoint(TRYCATCH, function(){
        this.visit(node.block);
      });
      var count = node.handlers.length,
          tryer = this.record(JUMP, 0),
          handlers = [tryer];

      for (var i=0; i < count; i++) {
        this.visit(node.handlers[i]);
        if (i < count - 1) {
          handlers.push(this.record(JUMP, 0));
        }
      }

      while (i--) {
        this.adjust(handlers[i]);
      }

      if (node.finalizer) {
        this.visit(node.finalizer);
      }
    },
    function UnaryExpression(node){
      this.visit(node.argument);
      this.record(UNARY, UNARYOPS.getIndex(node.operator));
    },
    function UpdateExpression(node){
      this.visit(node.argument);
      this.record(UPDATE, !!node.prefix | ((node.operator === '++') << 1));
    },
    function VariableDeclaration(node){
      var op = {
        'var': VAR,
        'const': CONST,
        'let': LET
      }[node.kind];

      for (var i=0, item; item = node.declarations[i]; i++) {
        if (item.init) {
          this.visit(item.init);
          this.record(GET);
        } else if (item.kind === 'let') {
          this.record(UNDEFINED);
        }

        this.record(op, item.id);

        if (node.kind === 'var') {
          this.code.VarDeclaredNames.push(item.id.name);
        }
      }
    },
    function VariableDeclarator(node){},
    function WhileStatement(node){
      this.withEntry(function(patch){
        var start = this.current();
        this.visit(node.test);
        this.record(GET);
        var op = this.record(IFEQ, 0, false)
        this.visit(node.body);
        this.record(JUMP, start);
        this.adjust(op)
        patch(this.current(), start);
      });
    },
    function WithStatement(node){
      this.visit(node.object)
      this.recordEntrypoint(ENTRY.hash.ENV, function(){
        this.record(WITH);
        this.visit(node.body);
        this.record(BLOCK_EXIT);
      });
    },
    function YieldExpression(node){

    }
  ]);


  function compile(code, options){
    var compiler = new Compiler(assign({ normal: false }, options));
    return compiler.compile(code);
  }

  exports.compile = compile;
  return exports;
})(typeof module !== 'undefined' ? module.exports : {});
