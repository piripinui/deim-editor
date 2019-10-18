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
      var myPromises = [];

      // Are there any "allOf" definitions?
      if (typeof origSchema.allOf != "undefined") {
        for (var i = 0; i < origSchema.allOf.length; i++) {
          var item = origSchema.allOf[i];
          if (typeof item["$ref"] != "undefined") {
            console.log("Processing reference " + JSON.stringify(item) + " at #allOf[" + i + "]");
            var subSchema = JSON.parse(deim[item["$ref"]]);
            myPromises.push(deref(subSchema));
          }
        };

        Promise.all(myPromises).then(function(data) {
          // Replace any allOf refs with the derefenced schema.
          for (var i = 0; i < myPromises.length; i++) {
            origSchema.allOf[i] = data[i];
          }
          var newSchema = removeSchemaDefs(origSchema, 0);
          console.log(JSON.stringify(newSchema, null, 2));
          newSchema = addDummyTitles(newSchema);
          console.log(JSON.stringify(newSchema, null, 2));
          var mergePromise = merge(newSchema);
          mergePromise.then(function(mergeData) {
            console.log("Merge finished.");
            console.log(JSON.stringify(mergeData, null, 2));
            res.json(mergeData);
          });
        })
      }
      else {
        var aPromise = deref(origSchema);
        aPromise.then(function(data) {
          console.log(data);
          res.json(data);
        })
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

function deref(mySchema) {
  var aPromise = new Promise(function(resolve, reject) {
    $RefParser.dereference(mySchema, {
      resolve: {
        file: fileResolver
      },
      dereference: {
        circular: "ignore"
      }
    }, (err, schema) => {
      if (err) {
        console.log("Dereferencing error.");
        console.error(err);
        reject(err);
      }
      else {
        // console.log(JSON.stringify(schema, null, 2));
        // Replace the titles of any dereferenced schemas.
        var props = schema.properties, sourceSchema = JSON.parse(deim[schema["$id"]]);
        for (var prop in props) {
          if (Object.prototype.hasOwnProperty.call(props, prop)) {
            // console.log("Processing " + prop + " " + schema.properties[prop].title + " " + sourceSchema.properties[prop].title);
            if (schema.properties[prop].title != "undefined") {
              schema.properties[prop].title = sourceSchema.properties[prop].title;
            }
          }
        }

        resolve(schema);
      }
    });
  });

  return aPromise;
}

function merge(mySchema) {
  var aPromise = new Promise(function(resolve, reject) {
    try {
      if (typeof mySchema.allOf != "undefined") {
        mySchema = mergeAllOf(mySchema);
        if (typeof mySchema.properties.required != "undefined") {
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

function addDummyTitles(mySchema, key) {
  var subSchema;
  console.log(mySchema);
  if (typeof mySchema.title == "undefined") {
    if (typeof key == "undefined") {
      mySchema.title = "Dummy title";
    }
    else {
      mySchema.title = key;
    }
  }

  for (var prop in mySchema) {
    if (Object.prototype.hasOwnProperty.call(mySchema, prop)) {
      console.log("Processing " + prop + " " + typeof mySchema[prop]);
      switch(typeof mySchema[prop]) {
        case 'object':
          subSchema = addDummyTitles(mySchema[prop], prop);
          mySchema[prop] = subSchema;
          break;
        case 'array':
          for (var i = 0; i < mySchema[prop].length; i++) {
            var item = mySchema[prop][i];
            subSchema = addDummyTitles(item, prop);
            mySchema[prop][i] = subSchema;
          }
          break;
        default:
          break;
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
