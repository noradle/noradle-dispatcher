var dlog = require('debug')('dispatcher')
  , auth = require('basic-auth')
  , fs = require('fs')
  , frame = require('noradle-protocol').frame
  , main = require('./dispatcher_http.js')
  , monServices = main.monServices
  , serviceNames = Object.keys(monServices)
  ;

function serveConsole(req, res){
  dlog('client normal request arrived, it must be from noradle-console');
  dlog('req.url=%s', req.url);
  dlog('req.headers=%j', req.headers);
  var role = req.headers['x-noradle-role']
    , tmp = auth(req) || {name : '', pass : ''}
    , name = tmp.name
    , pass = tmp.pass
    , ip = req.socket.remoteAddress
    ;
  if (role !== 'console') {
    res.writeHead(401, {'Content-Type' : 'text/plain'});
    res.write('only noradle-console is allowed to access');
    res.end();
    dlog('role!==console');
    return;
  }
  dlog('console(auth,id,pass,ip)=(%j,%s,%s,%s)', tmp, name, pass, ip);
  // todo: check console name:pass:ip for every request, no state here
  if (demoCheck('console', name, pass, ip)) {
    res.writeHead(401, {'Content-Type' : 'text/plain'});
    res.write('you are not allowed');
    res.end();
    dlog('user:pass:ip check failed');
    return;
  }
  dlog('user:pass:ip check passed');
  if (true) {
    // it's just a rest service, route by url.path
    var serverName = req.url.substr(1)
      , serviceIndex = serviceNames.indexOf(serverName)
      ;
    if (serviceIndex < 0) {
      res.writeHead(404, {'Content-Type' : 'text/plain'});
      res.write('no such service ' + serverName);
      res.end();
      return;
    }
    monServices[serviceName](function(data){
      var body = JSON.stringify(data);
      res.writeHead(200, {
        'Content-Type' : 'application/json',
        'Content-Length' : (new Buffer(body)).length
      });
      res.end(body);
    });
  }
}

function serveClientOracle(req, cltSocket, head){
  // connect to an origin server
  dlog('client upgrade request arrived');
  dlog('req.url=%s', req.url);
  dlog('req.headers=%j', req.headers);

  // ensure the client init request can pass through proxy(support websocket relay) to noradle dispatcher
  if (req.method === 'GET' && (req.headers.upgrade || '').toLowerCase() === 'websocket') ; else {
    socket.destroy();
    return true;
  }

  var role = req.headers['x-noradle-role']
    , namepass = auth(req) || {name : '', pass : ''}
    , name = namepass.name
    , pass = namepass.pass
    , ip = cltSocket.remoteAddress
    ;

  dlog('role=%s,user=%s,pass=%s,ip=%s', role, name, pass, ip);
  if (demoCheck(role, name, pass, ip)) {
    cltSocket.end('HTTP/1.1 401 Forbidden\r\n' +
      'WWW-Authenticate: Basic realm="example"\r\n' +
      '\r\n');
    return;
  }

  var response = [
    'HTTP/1.1 101 Switching Protocols',
    'Connection: Upgrade',
    'Upgrade: websocket',
    '',
    ''
  ].join('\r\n');

  cltSocket.write(response);
  dlog('%s connected', role);

  /**
   * 1. parse
   * parse tunnel socket data as frames
   *
   * 2. send
   * bind to one dbPool
   * when there is free connection is dbPool
   * send request there
   *
   * 3. recevie response
   *
   * 4. relay response to client
   */
  switch (role) {
    case 'client':
      // process frame
      // fakeTCPServer(cltSocket);
      main.serveClient(cltSocket, name);
      break;
    case 'oracle':
      // register in dbPools
      main.serveOracle(cltSocket, req.headers);
      break;
    default:
      // fake service for every on.data data
      fakeTCPServer(cltSocket);
  }
}

exports.serveConsole = serveConsole;
exports.serveClientOracle = serveClientOracle;

function fakeTCPServer(cltSocket){
  cltSocket.setEncoding('utf8');
  cltSocket.on('data', function(data){
    dlog('received (%s)', data);
    cltSocket.write('a response frame');
  });
  cltSocket.on('end', function(){
    dlog('client disconnect');
    cltSocket.end();
  });
}

/**
 * check if client is allowed to access dispatcher service
 * by default, use a configuration file
 * @param role
 * @param user
 * @param pass
 * @param cip
 * @returns {boolean} false:pass, any_string:error_type
 */
function check(role, user, pass, cip){
  return true;
}

function demoCheck(role, name, pass, cip){
  switch (role) {
    case 'console':
      return false;
      break;
    case 'client':
      if (name === 'demo' && pass !== 'demo') {
        dlog('name:pass error');
        return 'pass';
      }
      dlog('client address = (%s)', cip);
      if (name === 'demo' && cip !== '127.0.0.1') {
        dlog('name:cip error');
        return 'ip';
      }
      dlog('name:pass:cip check pass, client is allowed');
      return false;
    case 'oracle':
      return false;
      break;
  }
  return true;
}

function checkByConfig(configPath){
  var cfg = require(configPath);
  return function check(role, user, pass, cip){
    // check according to config rules
    return true;
  }
}