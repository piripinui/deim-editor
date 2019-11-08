const request = require('request'),
express = require('express'),
mergeAllOf = require('json-schema-merge-allof'),
Promise = require('promise'),
path = require('path'),
fs = require('fs');

var app = express(), deim = {}, shouldMerge = false;

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
  if (typeof req.query.shouldMerge != "undefined") {
    switch(req.query.shouldMerge) {
      case "true": {
        shouldMerge = true;
        break;
      }
      case "false": {
        shouldMerge = false;
        break;
      }
      case "default": {
        console.log("Error: Unrecognised value for query parameters shouldMerge - defaulting to false");
        break;
      }
    }
  }
  if (typeof req.params.schemaName != "undefined") {
    var schemaName = req.params.schemaName.split("=")[1];
    console.log("Fetching schema name " + schemaName);

    if (typeof deim[schemaName] != "undefined") {
      var origSchema = JSON.parse(deim[schemaName]);
      // Initialise globalDefinitions, which holds all schema definitions we want to put into "definitions".
      globalDefinitions = {};
      currentSchemaId = origSchema["$id"];
      origSchema = bundleRefs(origSchema);
      // Add definitions property to the schema and populate with content of globalDefinitions.
      for (var prop in globalDefinitions) {
        if (Object.prototype.hasOwnProperty.call(globalDefinitions, prop)) {
          if (typeof origSchema.definitions == "undefined")
            origSchema.definitions = {};
          origSchema.definitions[prop] = globalDefinitions[prop];
        }
      }

      if (typeof origSchema.allOf != "undefined" && shouldMerge) {
        // Merge the "allOfs" into one schema.
        var aPromise = merge(origSchema);
        aPromise.then(function(data) {
          data = addDummyTitlesToProperties(data);
          data = addDummyTitlesToDefinitions(data);
          res.json(data);
        })
      }
      else {
        // Leave "allOfs" in place.
        origSchema = addDummyTitlesToProperties(origSchema);
        origSchema = addDummyTitlesToDefinitions(origSchema);
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
    // We have got a reference to this schema i.e. a recursive reference. Leave the reference intact.
    console.log("Reference " + aSchema["$ref"] + ": refers to self - leaving intact.")

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
          // Remove any "$schema" and "$id" references since they define a schema. This confuse using the "#" anchor from within this schema as
          // it will expect "definitions" to be at the same level as the schema, when we want to use definitions at the root of the top-level schema.
          if (typeof refSchema["$schema"] != "undefined") {
            delete refSchema["$schema"];
          };
          if (typeof refSchema["$id"] != "undefined") {
            delete refSchema["$id"];
          };

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
  // This function traverses mySchema bundling up references to be placed in a single "definitions" property when finished.
  // It is called recursively as the structure is navigated.

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
            // For each item in the allOf array, bundle up the references.
            var anItem = bundleRefs(anItem, depth);
          });
          break;
        case 'properties':
          depth++;
          mySchema[prop] = bundleRefs(mySchema[prop], depth);
          break;
        case 'definitions':
          depth++;
          // Make sure that any definitions are bundled as well.
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
            // An array definition need not explicitly define "items" with types. If so, then any object can be in the array, in which case we leave it alone
            // since there will not be any references.
            if (typeof mySchema[prop].items != "undefined") {
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
      if (typeof mySchema[prop] == "object") {
        if (!Array.isArray(mySchema[prop])) {
          subSchema = addDummyTitles(mySchema[prop], prop);
          mySchema[prop] = subSchema;
        }
      }
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
