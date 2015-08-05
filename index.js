'use strict';

var scxml = require('scxml'),
  fs = require('fs'),
  express = require('express'),
  bodyParser = require('body-parser'),
  smaasJSON = require('smaas-swagger-spec'),
  urlModule = require('url'),
  path = require('path');

function init(initApi, pathToModel, cb){
  var app = express();

  var hostUrl = process.env.HOST_URL || 'http://localhost:3000';
  var parsedHostUrl = urlModule.parse(hostUrl);

  //init swagger
  smaasJSON.host = parsedHostUrl.host;
  smaasJSON.schemes = [parsedHostUrl.protocol.slice(0,-1)];
  app.get(smaasJSON.basePath + '/smaas.json', function (req, res) {
    res.status(200).send(smaasJSON);
  });

  //init static visualization stuff
  app.set('views', path.join(__dirname, './views'));
  app.engine('html', require('ejs').renderFile);
  app.use(express.static(path.join(__dirname, './node_modules/expresscion-portal/app')));
  app.use(express.static(path.join(__dirname, './public')));
  
  //TODO: add a nice command-line interface
  if(process.env.WATCH){
    //watch parent directory, because file watching is unstable
    var parent = path.resolve(pathToModel, '..');
    var watcher = fs.watch(parent);

    //publish changes on file
    app.get(smaasJSON.basePath + '/_changes', function(req, res){
      //read from file and publish
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      var tDelta = new Date();
      watcher.on('change',function(evt,fname){
        if(path.basename(pathToModel) === fname) {
          //debounce
          if((new Date() - tDelta) > 300){
            fs.readFile(pathToModel,function(err, data){
              tDelta = new Date();
              res.write('data: ' + JSON.stringify(data.toString()) + '\n\n');
            });
          }
        }
      });

      //keep the connection open
      var newlineHandle = setInterval(function(){
        res.write('\n');
      },5000)

      req.on('end',function(){
        res.close();
        watcher.close();
        clearInterval(newlineHandle);
      });
    });

    //TODO - reparse?
  }

  app.get('/:InstanceId/_viz', function (req, res) {
    res.render('viz.html', {
      type: 'instance'
    });
  });
  app.get('/_viz', function (req, res) {
    res.render('viz.html', {
      type: 'statechart'
    });
  });

  var scxmlString = fs.readFileSync(pathToModel,'utf8');

  switch(path.extname(pathToModel)){
    case '.js':
    case '.json':
      //read SCJSON model from filesystem
      var model = require(path.resolve('.',pathToModel));
      onModelReady(model, scxmlString);
      break;
    case '.xml':
    case '.scxml':
      //parse the SCXML and connect the SMaaS API
      scxml.pathToModel(pathToModel, function(err, model){
        if(err) return cb(err); 

        onModelReady(model, scxmlString);
      });
      break;
    default:
      return cb(new Error('Unknown file extension'));
  }

  function onModelReady(model, scxmlString){
    var modelName = process.env.APP_NAME || (model.meta && model.meta.name);
    initApi(model, scxmlString, modelName, function(err, api){

      if(err) return cb(err);

      Object.keys(smaasJSON.paths).forEach(function(endpointPath){
        var endpoint = smaasJSON.paths[endpointPath];
        var actualPath = smaasJSON.basePath + endpointPath.replace(/{/g, ':').replace(/}/g, '');

        Object.keys(endpoint).forEach(function(methodName){
          var method = endpoint[methodName];

          var handler = api[method.operationId];
          switch(methodName) {
            case 'get': {
              app.get(actualPath, handler);
              break;
            }
            case 'post': {
              if(method.consumes && method.consumes.indexOf('application/json') > -1){
                app.post(actualPath, bodyParser.json(), handler);
              } else {
                app.post(actualPath, handler);
              }
              break;
            }
            case 'put': {
              if(method.consumes && method.consumes.indexOf('application/json') > -1){
                app.put(actualPath, bodyParser.json(), handler);
              } else {
                app.put(actualPath, handler);
              }
              break;
            }
            case 'delete': {
              app.delete(actualPath, handler);

              break;
            }
            default:{
              return cb(new Error('Unsupported method name:' + methodName));
            }
          }
        });
      });

      cb(null, app); 
    });
  }
}

module.exports.initExpress = init;
module.exports.sse = require('./sse');
