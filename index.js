const request = require('request'),
express = require('express'),
$RefParser = require("json-schema-ref-parser"),
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
      // Return a dereferenced schema to the caller, ignoring any circular references.
      $RefParser.dereference(origSchema, {
        resolve: { file: fileResolver },
        dereference: {
          circular: "ignore"
        }
      }, (err, schema) => {
        if (err) {
          console.log("Dereferencing error.");
          console.error(err);
        }
        else {
          console.log(schema);
          // Replace the titles of any dereferenced schemas.
          var props = origSchema.properties, sourceSchema = JSON.parse(deim[schemaName]);
          for (var prop in props) {
            if (Object.prototype.hasOwnProperty.call(props, prop)) {
              // console.log("Processing " + prop + " " + schema.properties[prop].title + " " + sourceSchema.properties[prop].title);
              schema.properties[prop].title = sourceSchema.properties[prop].title;
            }
          }
          res.json(schema);
        }
      });
    }
    else {
      res.send("Error: Cannot find a schema called " + schemaName);
    }
  }
  else {
    res.send("Error: No schema name provided.");
  }
})

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
