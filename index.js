const request = require('request'),
express = require('express'),
$RefParser = require("json-schema-ref-parser"),
mergeAllOf = require('json-schema-merge-allof'),
Promise = require('promise'),
path = require('path'),
fs = require('fs');

var app = express(), deim = {};

function readDir(dirname, onFileContent, onError) {
  fs.readdir(dirname, function(err, filenames) {
    if (err) {
      onError(err);
      return;
    }
    filenames.forEach(function(filename) {
      fs.readFile(dirname + filename, 'utf-8', function(err, content) {
        if (err) {
          onError(err);
          return;
        }
        onFileContent(filename, content);
      });
    });
  });
}

function initialise() {
  readDir('deim/', function(filename, content) {
    deim[filename] = content;
  }, function(err) {
    throw err;
  });
}

initialise();

app.set('json spaces', 3);

let fileResolver = {
  order: 1,

  canRead: true,

  read(file) {
    var bn = path.basename(file.url);
    var dn = path.dirname(file.url);
    var newPath = path.format({
      dir: dn + "/deim",
      base: bn
    });
    return fs.readFileSync(newPath);
  }
};

app.get('/deim/getSchema/:schemaName', function(req, res) {
  if (typeof req.params.schemaName != "undefined") {
    var schemaName = req.params.schemaName.split("=")[1];
    console.log("Fetching schema name " + schemaName);

    if (typeof deim[schemaName] != "undefined") {
      var origSchema = JSON.parse(deim[schemaName]);
      globalDefinitions = {};
      currentSchemaId = origSchema["$id"];
      origSchema = bundleRefs(origSchema);
      // Add definitions.
      for (var prop in globalDefinitions) {
        if (Object.prototype.hasOwnProperty.call(globalDefinitions, prop)) {
          if (typeof origSchema.definitions == "undefined")
            origSchema.definitions = {};
          origSchema.definitions[prop] = globalDefinitions[prop];
        }
      }
      // Merge if there is an allOf.
      if (typeof origSchema.allOf != "undefined") {
        var aPromise = merge(origSchema);
        aPromise.then(function(data) {
          data = addDummyTitlesToProperties(data);
          data = addDummyTitlesToDefinitions(data);
          console.log(JSON.stringify(data, null, 2));
          res.json(data);
        })
      }
      else {
        origSchema = addDummyTitlesToProperties(origSchema);
        origSchema = addDummyTitlesToDefinitions(origSchema);
        console.log(JSON.stringify(origSchema, null, 2));
        res.json(origSchema);
      }
    }
    else {
      res.send("Error: Cannot find a schema called " + schemaName);
    }
  }
  else {
    res.send("Error: No schema name provided.");
  }
})

var globalDefinitions = {};
var currentSchemaId;
var definitionStack = [];

function refactorRef(aSchema, depth) {
  // Refactoring a schema which has a $ref property on it.
  var ref = aSchema["$ref"];
  var aSchema;

  if (typeof depth == "undefined")
    depth = 0;

  if (aSchema["$ref"] == currentSchemaId) {
    console.log("Ignoring " + aSchema["$ref"] + ": refers to self.")
    return aSchema;
  }

  if (definitionStack.includes(ref)) {
    // We are already processing this reference - just update the schema to refer to it in the definitions.
    aSchema["$ref"] = "#/definitions/" + ref;
  }
  else {
    // Starting to process a new reference.
    definitionStack.push(ref);

    if (ref[0] != '#') {
      // It's an external ref, fetch it and add it to "definitions".
      if (typeof globalDefinitions[ref] == "undefined") {
        if (typeof deim[ref] != "undefined") {
          var refSchema = JSON.parse(deim[ref]);
          // The referenced schema may itself have references, so bundle them.
          globalDefinitions[ref] = bundleRefs(refSchema, depth++);
        }
        else {
          console.log("Could not find schema " + ref);
        }
      }
      // Create internal reference to definitions.
      aSchema["$ref"] = "#/definitions/" + ref;
    }

    definitionStack.pop();
  }

  return aSchema;
}

function bundleRefs(mySchema, depth) {

  console.log(definitionStack);
  if (typeof depth == "undefined")
    depth = 0;
  var indent = "";
  for (var i = 0; i < depth; i++) {
    indent += " ";
  }
  for (var prop in mySchema) {
    // console.log("Processing " + indent + prop);
    if (Object.prototype.hasOwnProperty.call(mySchema, prop)) {
      switch(prop) {
        case '$ref':
          var ref = mySchema[prop];
          if (ref[0] != "#" && typeof globalDefinitions[ref] == "undefined")
            // If the reference isn't internal and doesn't exist globally, add it.
            mySchema = refactorRef(mySchema, depth);
          break;
        case 'allOf':
          depth++;
          mySchema[prop].forEach(function(anItem) {
            var anItem = bundleRefs(anItem, depth);
          });
          break;
        case 'properties':
          depth++;
          mySchema[prop] = bundleRefs(mySchema[prop], depth);
          break;
        case 'definitions':
          depth++;
          var bundledDefs = bundleRefs(mySchema[prop], depth);
          for (var defProp in bundledDefs) {
            if (Object.prototype.hasOwnProperty.call(bundledDefs, defProp)) {
              globalDefinitions[defProp] = bundledDefs[defProp];
            }
          }
          break;
        default:
          // If this property consists of only a $ref, process it immediately.
          if (typeof mySchema[prop]["$ref"] != "undefined") {
            var ref = mySchema[prop]["$ref"];
            if (ref[0] != "#") {
              // Got an external reference.
              if (typeof globalDefinitions[ref] == "undefined") {
                // There isn't an existing definition for it so create on
                mySchema[prop] = refactorRef(mySchema[prop], depth);
                continue;
              }
              else {
                // There is an existing definition for it, so just update the schema reference.
                mySchema[prop]["$ref"] = "#/definitions/" + ref;
              }
            }
          }

          // An array may have external refs too.
          if (typeof mySchema[prop].type != "undefined" && mySchema[prop].type == "array") {
            if (typeof mySchema[prop].items["$ref"] != "undefined") {
              var ref = mySchema[prop].items["$ref"];
              if (ref[0] != "#") {
                // Got an external reference.
                if (typeof globalDefinitions[ref] == "undefined") {
                  // There isn't an existing definition for it so create one.
                  mySchema[prop].items = refactorRef(mySchema[prop].items, depth);
                  continue;
                }
                else {
                  // There is an existing definition for it, so just update the schema reference.
                  mySchema[prop].items["$ref"] = "#/definitions/" + ref;
                }
              }
            }
          }

          // If it is an object it may have a schema structure that we need to bundle.
          if (typeof mySchema[prop] == "object") {
            depth++;
            mySchema[prop] = bundleRefs(mySchema[prop], depth++);
            continue;
          }
          break;
      }
    }
  }

  return mySchema;
}

function merge(mySchema) {
  var aPromise = new Promise(function(resolve, reject) {
    try {
      if (typeof mySchema.allOf != "undefined") {
        mySchema = mergeAllOf(mySchema);
        if (typeof mySchema.properties != "undefined" && typeof mySchema.properties.required != "undefined") {
          // Hack. Remove required: true property that somehow gets into the schema when we run mergeAllOf.
          delete mySchema.properties.required;
        }
      }

      resolve(mySchema);
    }
    catch(err) {
      console.log(err);
      reject(err);
    }
  });

  return aPromise;
}

function removeSchemaDefs(mySchema, depth) {
  // Removes any $schema and $id properties from sub-schemas.
  if (typeof depth == "undefined") {
    depth = 0;
  };

  for (var prop in mySchema) {
    if (Object.prototype.hasOwnProperty.call(mySchema, prop)) {
      switch(prop) {
        case '$schema':
          if (depth > 0)
            delete mySchema["$schema"];
          break;
        case '$id':
          if (depth > 0)
            delete mySchema["$id"];
          break;
        default:
          var val = mySchema[prop];
          if (typeof val == "object") {
            var subSchema = removeSchemaDefs(val, depth + 1);
            mySchema[prop] = subSchema;
          }
          if (typeof val == "array") {
            for (var i = 0; i < val.length; i++) {
              var item = val[i];
              if (typeof val == "Object") {
                var subSchema = removeSchemaDefs(val, depth + 1);
                mySchema[prop] = subSchema;
              }
            }
          }
          break;
      }
    }
  }

  return mySchema;
}

function addDummyTitlesToProperties(mySchema) {
  for (var prop in mySchema.properties) {
    if (Object.prototype.hasOwnProperty.call(mySchema.properties, prop)) {
      mySchema.properties[prop] = addDummyTitles(mySchema.properties[prop], prop);
    }
  }

  return mySchema;
}

function addDummyTitlesToDefinitions(mySchema) {
  for (var prop in mySchema.definitions) {
    if (Object.prototype.hasOwnProperty.call(mySchema.definitions, prop)) {
      mySchema.definitions[prop] = addDummyTitles(mySchema.definitions[prop], prop);
    }
  }

  return mySchema;
}

function addDummyTitles(mySchema, key) {
  var subSchema;
  // console.log(mySchema);
  if (key != "properties" && key != "definitions" && typeof mySchema.title == "undefined") {
    if (typeof key == "undefined") {
      mySchema.title = "Dummy title";
    }
    else {
      mySchema.title = key;
    }
  }

  for (var prop in mySchema) {
    if (Object.prototype.hasOwnProperty.call(mySchema, prop)) {
      // console.log("Processing " + prop + " " + typeof mySchema[prop]);

      if (typeof mySchema[prop] == "object") {
        if (!Array.isArray(mySchema[prop])) {
          subSchema = addDummyTitles(mySchema[prop], prop);
          mySchema[prop] = subSchema;
        }
      }

      // switch(typeof mySchema[prop]) {
      //   case 'object':
      //     subSchema = addDummyTitles(mySchema[prop], prop);
      //     mySchema[prop] = subSchema;
      //     break;
      //   case 'array':
      //     for (var i = 0; i < mySchema[prop].length; i++) {
      //       var item = mySchema[prop][i];
      //       subSchema = addDummyTitles(item, prop);
      //       mySchema[prop][i] = subSchema;
      //     }
      //     break;
      //   default:
      //     break;
      // }
    }
  }

  return mySchema;
}

app.get('/deim/listschemas', function(req, res) {
  var schemaList = [];
  for (var prop in deim) {
    if (Object.prototype.hasOwnProperty.call(deim, prop)) {
        schemaList.push(prop);
    }
  };

  res.json(schemaList);
})

app.use(express.static(path.join(__dirname, '.')));

app.listen(3000, function () {
	console.log('deim-usage-examples listening on port ' + 3000 + '!');
});
