# deim-editor
Server for bundling Digital Enterprise Information Model (DEIM) schemas and creating editor forms from them.
To install:
* Copy all the DEIM JSON schema files into a directory called `deim`
* Run the server by executing `node index.js`

To see a bundled version of a DEIM schema makea GET request similar to the following:
`http://localhost:3000/deim/getSchema/schemaName=de.workorder.api.createupdate.fieldworker.request-1.0.0.json`

The response will return the JSON schema but with all external references bundled into the `definitions` section of the schema.
The automatically generated forms use [react-json-form](https://www.npmjs.com/package/react-jsonschema-form). To see them navigate to `http://localhost:3000/public/index.html`. This will allow you to select some of the schemas and will create a form based on them.
