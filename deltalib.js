exports = module.exports = {};

var fs = require("fs"),
    util = require("util"),
    esprima = require("esprima"),
    escodegen = require("escodegen"),
    estraverse = require("estraverse"),
    cp = require("child_process"),
    config = require(__dirname + "/config.js");

var DEBUG = false;
function log_debug(msg) {
    if (DEBUG)
        console.log(msg);
}

//Globals
var tmp_dir,
    // keep track of the number of attempts so far
    round = 0,
    ext,
    ast,
    smallest,
    testSucceededAtLeastOnce;

//Options
var /** only knock out entire statements */
    quick = false,

    /** Repeat until a fixpoint is found */
    findFixpoint = true,

    /** file to minimise */
    file = null,

    /** predicate to use for minimisation */
    predicate = {},

    /** arguments to pass to the predicate */
    predicate_args = [],

    /** file to record predicate results to */
    record = null,

    /** predicate set in multifile mode */
    multifile_mode = false;


function parseOptions(options) {
    quick = options.quick;
    findFixpoint = options.findFixpoint;
    file = options.file;
    predicate = options.predicate; 
    predicate_args = options.predicate_args;
    record = options.record;
    multifile_mode = options.multifile_mode;
}

exports.usage = function () {
    console.error("Usage: " + process.argv[0] + " " + process.argv[1] +
            " [-q|--quick] [--no-fixpoint] [--cmd COMMAND]" +
            " [--record FILE | --replay FILE]" +
            " [--errmsg ERRMSG] [--msg MSG] FILE [PREDICATE] OPTIONS...");
    process.exit(-1);
}

exports.main = function (options) {
    parseOptions(options);
    // check that we have something to minimise
    if (!file)
        exports.usage();

    var src = fs.readFileSync(file, 'utf-8');

    // figure out file extension; default is 'js'
    ext = (file.match(/\.(\w+)$/) || [, 'js'])[1]
    // hack to make JSON work
    if (ext === 'json')
        src = '(' + src + ')';

    // parse given file
    ast = esprima.parse(src);

    // determine a suitable temporary directory
    for (i = 0; fs.existsSync(tmp_dir = config.tmp_dir + "/tmp" + i); ++i);
    fs.mkdirSync(tmp_dir);

    // the smallest test case so far is kept here
    smallest = tmp_dir + "/delta_js_smallest." + ext;

    testSucceededAtLeastOnce = false;
    // test the current test case

    // save a copy of the original input
    var orig = getTempFileName(),
        input = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(orig, input);
    fs.writeFileSync(smallest, input);

    // get started
    var res = predicate.test(orig);
    if (record)
        fs.appendFileSync(record, !!res + "\n");
    if (res) {
        if (findFixpoint) {
            var iterations = 0;
            do {
                testSucceededAtLeastOnce = false;
                console.log("Starting fixpoint iteration #%d", ++iterations);
                minimise(ast, null, -1);
            } while (testSucceededAtLeastOnce);
        } else {
            minimise(ast, null, -1);
        }
        var stats = fs.statSync(smallest);
        if (stats.size < 2000) {
            // small enough to display
            console.log();
            console.log(fs.readFileSync(smallest, 'utf8'));
            console.log();
        }
	if (!multifile_mode) {
            console.log("Minimisation finished; final version is in %s (%d bytes)", smallest, stats.size);
	}
        //process.exit(0);
    } else {
        console.error("Original file doesn't satisfy predicate.");
        process.exit(-1);
    }
}

function minimise_array(array, nonempty) {
    log_debug("minimising array " + util.inspect(array, false, 1));
    if (!nonempty && array.length === 1) {
		// special case: if there is only one element, try removing it
		var elt = array[0];
		array.length = 0;
		if (!test())
			// didn't work, need to put it back
			array[0] = elt;
    } else {
		// try removing as many chunks of size sz from array as possible
		// once we're done, switch to size sz/2; if size drops to zero,
		// recursively invoke minimise on the individual elements
		// of the array
		for (var sz = array.length >>> 1; sz > 0; sz >>>= 1) {
			log_debug("  chunk size " + sz);
			var nchunks = Math.floor(array.length / sz);
			for (var i = nchunks - 1; i >= 0; --i) {
				// try removing chunk i
				log_debug("    chunk #" + i);
				var lo = i * sz,
					hi = i === nchunks - 1 ? array.length : (i + 1) * sz;

				// avoid creating empty array if nonempty is set
				if (!nonempty || lo > 0 || hi < array.length) {
					var removed = array.splice(lo, hi - lo);
					if (!test()) {
						// didn't work, need to put it back
						Array.prototype.splice.apply(array,
							[lo, 0].concat(removed));
					}
				}
			}
		}
    }

    // now minimise each element in turn
    for (var i = 0; i < array.length; ++i)
		minimise(array[i], array, i);
}

// the main minimisation function
function minimise(nd, parent, idx) {
    if (typeof parent === 'string') {
		idx = parent;
		parent = nd;
		nd = parent[idx];
    }

    if (!nd || typeof nd !== 'object')
		return;

    log_debug("minimising " + util.inspect(nd));
    switch (nd.type) {
		case 'Program':
			minimise_array(nd.body);
			break;
		case 'BlockStatement':
			// knock out as many statements in the block as possible
			// if we end up with a single statement, replace the block with
			// that statement
			minimise_array(nd.body);
			if (!quick && nd.body.length === 1)
				Replace(parent, idx).With(nd.body[0]);
			break;
		case 'FunctionDeclaration':
		case 'FunctionExpression':
			if (!quick) {
				if (nd.type === 'FunctionExpression')
					Replace(nd, 'name').With(null);
				minimise_array(nd.params);
			}
			minimise_array(nd.body.body);
			break;
		case 'ObjectExpression':
			minimise_array(nd.properties);
			break;
		case 'VariableDeclaration':
			minimise_array(nd.declarations, true);
			break;
		default:
			// match other node types only if we're not doing quick minimisation
			// if quick is set, !quick && ndtp will be undefined, so the
			// default branch is taken
			switch (!quick && nd.type) {
				case 'Literal':
					return;
				case 'UnaryExpression':
				case 'UpdateExpression':
					// try replacing with operand
					if (Replace(parent, idx).With(nd.argument))
						minimise(parent, idx);
					else
						minimise(nd, 'argument');
					break;
				case 'AssignmentExpression':
				case 'BinaryExpression':
				case 'LogicalExpression':
					if (Replace(parent, idx).With(nd.left))
						minimise(parent, idx);
					else if (Replace(parent, idx).With(nd.right))
						minimise(parent, idx);
					else {
						minimise(nd, 'left');
						minimise(nd, 'right');
					}
					break;
				case 'ReturnStatement':
					if (nd.argument && !Replace(nd, 'argument').With(null))
						minimise(nd, 'argument');
					break;
				case 'CallExpression':
				case 'NewExpression':
					minimise(nd, 'callee');
					minimise_array(nd['arguments']);
					break;
				case 'ArrayExpression':
					minimise_array(nd.elements);
					break;
				case 'IfStatement':
				case 'ConditionalExpression':
					if (Replace(parent, idx).With(nd.consequent))
						minimise(parent, idx);
					else if (nd.alternate && Replace(parent, idx).With(nd.alternate))
						minimise(parent, idx);
					else if (Replace(parent, idx).With(nd.test))
						minimise(parent, idx);
					else {
						minimise(nd, 'test');
						minimise(nd, 'consequent');
						minimise(nd, 'alternate');
					}
					break;
				case 'SwitchStatement':
					minimise(nd, 'discriminant');
					minimise_array(nd.cases);
					break;
				case 'WhileStatement':
					if (Replace(parent, idx).With(nd.body))
						minimise(parent, idx);
					else if (Replace(parent, idx).With(nd.test))
						minimise(parent, idx);
					else {
						minimise(nd, 'test');
						minimise(nd, 'body');
					}
					break;
				case 'ForStatement':
					Replace(nd, 'test').With(null);
					Replace(nd, 'update').With(null);
					if (Replace(parent, idx).With(nd.body))
						minimise(parent, idx);
					else if (nd.test && Replace(parent, idx).With(nd.test))
						minimise(parent, idx);
					else {
						minimise(nd, 'init');
						minimise(nd, 'test');
						minimise(nd, 'update');
						minimise(nd, 'body');
					}
					break;
				default:
					if (Array.isArray(nd)) {
						minimise_array(nd);
					} else {
						estraverse.VisitorKeys[nd.type].forEach(function (ch) {
							if (!quick || ch !== 'arguments') {
								minimise(nd, ch);
							}
						});
					}
			}
    }
}

function pp(ast) {
    // we pass the 'parse' option here to avoid converting 0.0 to 0, etc.;
    // for JSON files, we skip the top-level `Program` and `ExpressionStatement`
    // nodes to prevent escodegen from inserting spurious parentheses
    return escodegen.generate(ext === 'json' && ast.body[0] ? ast.body[0].expression : ast, {
		format: {
			json: ext === 'json'
		},
        parse: esprima.parse
    });
}

// write the current test case out to disk
function writeTempFile() {
    var fn = getTempFileName();
    fs.writeFileSync(fn, pp(ast));
    return fn;
}

function test() {
    var fn = writeTempFile();
    var res = predicate.test(fn);
    if (record)
		fs.appendFileSync(record, !!res + "\n");
    if (res) {
        testSucceededAtLeastOnce = true;
		// if the test succeeded, save it to file 'smallest'
		fs.writeFileSync(smallest, pp(ast));
		return true;
    } else {
		return false;
    }
}

function Replace(nd, idx) {
    var oldval = nd[idx];
    return {
		With: function (newval) {
			if (oldval === newval) {
				return true;
			} else {
				nd[idx] = newval;
				if (test()) {
					return true;
				} else {
					nd[idx] = oldval;
					return false;
				}
			}
		}
    };
}

execSync = function (cmd) {
    if (cp.execSync) {
        // node v0.12; use the built-in functionality
        try {
            cp.execSync(cmd);
            return false;
        } catch (e) {
            return true;
        }
    } else {
        // node v0.10; fall back on execSync package
        return require("execSync").run(cmd);
    }
}

// get name of current test case
getTempFileName = function () {
    var fn = tmp_dir + "/delta_js_" + round + "." + ext;
    ++round;
    return fn;
}
